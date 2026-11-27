/**
 * Task planner bundle: a `task_plan` tool, a system-prompt planning policy, a
 * one-line start-of-turn reminder, and a plugin-capability directory published
 * through the runtime-context snapshot so the agent decomposes new requests
 * before acting, including identifying the installed plugins it will rely on.
 *
 * Context cost is bounded by design: the full planning requirements live only
 * in the system prompt, the plugin directory rides the rolling runtime-context
 * snapshot (re-sent only when the catalog actually changes), and the per-turn
 * reminder is a single pointer line.
 *
 * Guidance-only by design: no tool calls are intercepted and no session event
 * types are added; every registration lives in this plugin's effect scope.
 *
 * @module @local/task-planner
 */

import { randomUUID } from 'node:crypto'

// Process-constant install anchor, read once instead of per call.
const INSTALL_ANCHOR = typeof process.env.DSH_INSTALL_DIR === 'string' && process.env.DSH_INSTALL_DIR.length > 0
  ? process.env.DSH_INSTALL_DIR
  : undefined

/** Host services this plugin requires. */
export const inject = ['tools', 'systemPrompt']

/**
 * Import a package shipped with the running DSH installation. Dynamic imports
 * from a profile-installed plugin resolve against the plugin's own directory,
 * which does not contain the installation's node_modules, so fall back to
 * resolving through the DSH installation anchor.
 * @param {string} specifier - bare package specifier, such as `@deepseek-ai/dsh-tools`.
 * @returns {Promise<Record<string, unknown>>} the package module.
 */
async function importHostPackage(specifier) {
  try {
    return await import(specifier)
  } catch {
    // Fall through to the installation anchor.
  }
  if (INSTALL_ANCHOR !== undefined) {
    const { createRequire } = await import('node:module')
    const { join } = await import('node:path')
    const { pathToFileURL } = await import('node:url')
    const hostRequire = createRequire(join(INSTALL_ANCHOR, 'package.json'))
    try {
      return hostRequire(specifier)
    } catch {
      try {
        return await import(pathToFileURL(hostRequire.resolve(specifier)).href)
      } catch {
        // Fall through to the failure below.
      }
    }
  }
  throw new Error(`task-planner: cannot resolve host package "${specifier}"`)
}

const DEFAULT_POLICY_TEXT = [
  '## Task planning policy',
  '',
  'When the user asks a question or starts a task, judge the work before acting:',
  '',
  '- For a multi-step task, or any request that will create or change files, run commands, or call other tools beyond a trivial amount, FIRST call the `task_plan` tool to record a structured plan: the goal, assumptions, ordered steps with dependencies, the installed plugins or capabilities the task will rely on, and acceptance criteria. After a successful plan, immediately mirror the steps with the `todo_write` tool (when available) and keep that list updated while you work.',
  '- Identify the plugins the task needs from the available-plugins directory provided with each new request; record them in the `plugins` field with why each one is needed. Do not name plugins that are absent from that directory.',
  '- For simple lookups, short questions, greetings, or one-shot answers, respond directly; do not plan.',
  '- If a request turns out to be bigger than it first appeared, call `task_plan` before continuing.',
  '- When planning, actively consider whether parts of the work can run in parallel: independent steps with no shared write scope can be delegated to multiple subagents started together, while steps that write the same files or depend on earlier steps stay sequential (order them with `depends_on`).',
  '- After finishing a task, close it out: bring the project\'s cognition index back into alignment (cognition_scan, then cognition_update_entries / cognition_remove_entries until cognition_verify returns aligned=true), and if the workspace is not a git repository yet, ask the user once whether to create a repository (e.g. on GitHub) and push, respecting a previously declined answer.',
  '- When implementing, do not fall back to defensive output (merely adding code): prefer the smallest total change — edit or reuse existing code and remove what is no longer needed, rather than layering \u0022just in case\u0022 guards and extra branches on top.',
  '',
  'Keep the three planning models distinct: `task_plan` is the upfront structured plan (goal, assumptions, steps, acceptance, risks); `todo_write` mirrors its steps for execution tracking while you work; `create_goal` is only for long-running objectives that must survive across automatic continuation rounds. Do not duplicate one plan into all three; update `todo_write` when steps change and leave `task_plan` as the record of the original intent.',
].join('\n')

// One pointer line: the full requirements stay in the system prompt policy, so
// the per-turn reminder must not repeat them.
const DEFAULT_NUDGE_TEXT = [
  '<system-reminder>',
  'New user input. For non-trivial work, record a plan with `task_plan` first, then mirror the steps with `todo_write` (see the task planning policy above); a simple question can be answered directly without planning.',
  '</system-reminder>',
].join('\n')

const CONFIG_DEFAULTS = Object.freeze({
  enabled: true,
  nudgeOnNewTurn: true,
  pluginCatalog: true,
  maxCatalogEntries: 200,
  policyText: DEFAULT_POLICY_TEXT,
  nudgeText: DEFAULT_NUDGE_TEXT,
})

function configIssue(message) {
  return { issues: [{ message }] }
}

function configString(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function clampInteger(value, fallback, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

/** Apply defaults and clamping to a raw config value; the single normalization site. */
function normalizeConfig(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    enabled: value.enabled === undefined ? CONFIG_DEFAULTS.enabled : value.enabled,
    nudgeOnNewTurn: value.nudgeOnNewTurn === undefined ? CONFIG_DEFAULTS.nudgeOnNewTurn : value.nudgeOnNewTurn,
    pluginCatalog: value.pluginCatalog === undefined ? CONFIG_DEFAULTS.pluginCatalog : value.pluginCatalog,
    maxCatalogEntries: clampInteger(value.maxCatalogEntries, CONFIG_DEFAULTS.maxCatalogEntries, 0, 200),
    policyText: configString(value.policyText, CONFIG_DEFAULTS.policyText),
    nudgeText: configString(value.nudgeText, CONFIG_DEFAULTS.nudgeText),
  }
}

/**
 * Standard Schema (https://github.com/standard-schema/standard-schema) view of
 * this plugin's configuration, with built-in defaults for omitted fields.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'task-planner',
    validate(value) {
      const raw = value !== null && typeof value === 'object' ? value : {}
      for (const key of ['enabled', 'nudgeOnNewTurn', 'pluginCatalog']) {
        if (raw[key] !== undefined && typeof raw[key] !== 'boolean') {
          return configIssue(`task-planner config: "${key}" must be a boolean`)
        }
      }
      if (raw.maxCatalogEntries !== undefined && !Number.isInteger(raw.maxCatalogEntries)) {
        return configIssue('task-planner config: "maxCatalogEntries" must be an integer')
      }
      for (const key of ['policyText', 'nudgeText']) {
        if (raw[key] !== undefined && typeof raw[key] !== 'string') {
          return configIssue(`task-planner config: "${key}" must be a string`)
        }
      }
      return { value: normalizeConfig(raw) }
    },
  },
}

/** Resolve a LocalizedText (literal string or {en, [locale]}) for display. */
function pickText(text) {
  if (typeof text === 'string') return text
  if (text !== null && typeof text === 'object') return text.zh ?? text.en ?? ''
  return ''
}

// The inventory reader needs a Context; `apply` assigns it before any use.
let ctxCatalog

/**
 * Cached catalog with a cheap fingerprint of the Loader entry list. The
 * fingerprint captures every input the catalog derives from (entry names,
 * disabled flags, fiber states), so an unchanged fingerprint skips all
 * metaOf lookups while preserving live-inventory semantics.
 */
let catalogCache = { fingerprint: '', rows: [], known: new Set(), suffix: undefined, maxEntries: -1 }

/** Fingerprint the Loader entries the catalog depends on. */
function catalogFingerprint(loader) {
  const parts = []
  for (const entry of loader.entries()) {
    parts.push(entry.options?.name ?? '')
    parts.push(entry.disabled === true ? 'd' : 'e')
    parts.push(String(entry.fiber === undefined ? -1 : entry.fiber.state))
  }
  return parts.join('\u0000')
}

/** Resolve display metadata for one Loader entry with layered fallbacks. */
function metaForEntry(entry, packages, treeBase) {
  if (packages === undefined) return undefined
  const name = entry.options.name
  const bases = treeBase !== undefined ? [treeBase, INSTALL_ANCHOR] : [INSTALL_ANCHOR]
  for (const base of bases) {
    if (base === undefined) continue
    try {
      const meta = packages.metaOf(name, base)
      if (meta !== undefined) return meta
    } catch {
      // Try the next base; a final miss yields no display metadata.
    }
  }
  return undefined
}

/**
 * Read the live plugin inventory: enabled, active, non-group Loader entries
 * with display metadata, deduplicated by module name, in Loader order.
 * Cached by the Loader fingerprint; returns the shared rows/known objects.
 * @returns {{rows: Array<{name: string, title: string, description: string}>, known: Set<string>}}
 */
function readCatalog() {
  try {
    const loader = ctxCatalog?.loader ?? ctxCatalog?.get?.('loader')
    if (loader === undefined || typeof loader.entries !== 'function') return catalogCache
    const fingerprint = catalogFingerprint(loader)
    if (catalogCache.fingerprint === fingerprint) return catalogCache
    let packages
    try {
      packages = ctxCatalog.get('pluginPackages')
    } catch {
      packages = undefined
    }
    const rows = []
    const seen = new Set()
    for (const entry of loader.entries()) {
      if (entry.options?.group === true || entry.disabled === true) continue
      const fiber = entry.fiber
      if (fiber !== undefined && fiber.state !== 2 /* FiberState.ACTIVE */) continue
      if (seen.has(entry.options.name)) continue
      seen.add(entry.options.name)
      const meta = metaForEntry(entry, packages, entry.parent?.tree?.ctx?.baseUrl)
      const title = meta === undefined ? '' : pickText(meta.title)
      const description = meta === undefined ? '' : pickText(meta.description)
      if (title.length === 0 && description.length === 0) continue
      rows.push({ name: entry.options.name, title, description })
    }
    const known = new Set()
    for (const row of rows) {
      known.add(row.name)
      if (row.title.length > 0) known.add(row.title)
    }
    catalogCache = { fingerprint, rows, known, suffix: undefined, maxEntries: -1 }
    return catalogCache
  } catch {
    // Any unexpected Loader failure leaves the previous (or initial empty) cache.
    return catalogCache
  }
}

/** Render the bounded plugin directory text for the runtime-context snapshot. */
function renderCatalog(catalog, maxEntries) {
  if (maxEntries <= 0 || catalog.length === 0) return ''
  const lines = []
  for (const row of catalog.slice(0, maxEntries)) {
    const label = row.title.length > 0 ? `${row.name} (${row.title})` : row.name
    lines.push(`- ${label}${row.description.length > 0 ? ` — ${row.description}` : ''}`)
  }
  const omitted = catalog.length - Math.min(catalog.length, maxEntries)
  const tail = omitted > 0 ? `\n- …${omitted} more active plugins omitted.` : ''
  return `Available plugins in this environment (name (title) — description); when planning, pick from these for the \`plugins\` field:\n${lines.join('\n')}${tail}`
}

/** Build the model-facing plan summary returned by `task_plan`. */
function renderPlan(value) {
  const lines = [`Task plan recorded. Goal: ${value.goal}`]
  if (value.assumptions.length > 0) {
    lines.push('Assumptions:')
    for (const assumption of value.assumptions) lines.push(`- ${assumption}`)
  }
  if (value.plugins.length > 0) {
    lines.push('Required plugins/capabilities:')
    for (const plugin of value.plugins) lines.push(`- ${plugin.name}: ${plugin.purpose}`)
  }
  if (value.unknownPlugins.length > 0) {
    lines.push(`Names not found in the available-plugins directory (verify or remove them; built-in tools and skills must not be listed): ${value.unknownPlugins.join(', ')}`)
  }
  if (value.risks.length > 0) {
    lines.push('Risks:')
    for (const risk of value.risks) lines.push(`- ${risk}`)
  }
  lines.push('Steps (execute in order; respect depends_on):')
  for (const step of value.steps) {
    const dependsOn = step.depends_on.length > 0 ? ` [after: ${step.depends_on.join(', ')}]` : ''
    lines.push(`${step.index}. ${step.title} — ${step.detail}${dependsOn}`)
  }
  lines.push('Acceptance criteria:')
  for (const criterion of value.acceptance) lines.push(`- ${criterion}`)
  lines.push('Next: mirror these steps with `todo_write` (when available), then begin step 1.')
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Validate the plan the schema cannot express; throws a fixable message on failure. */
function toCanonicalPlan(raw) {
  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : ''
  if (goal.length === 0) throw new Error('invalid task_plan: `goal` must be a non-empty string')
  const assumptions = (raw.assumptions ?? []).map(item => item.trim()).filter(item => item.length > 0)
  const risks = (raw.risks ?? []).map(item => item.trim()).filter(item => item.length > 0)
  const acceptance = (raw.acceptance ?? [])
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .filter(item => item.length > 0)
  if (acceptance.length === 0) {
    throw new Error('invalid task_plan: `acceptance` needs at least one non-empty criterion')
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new Error('invalid task_plan: `steps` needs at least one step')
  }
  const steps = raw.steps.map((step, position) => {
    const title = typeof step.title === 'string' ? step.title.trim() : ''
    const detail = typeof step.detail === 'string' ? step.detail.trim() : ''
    if (title.length === 0 || detail.length === 0) {
      throw new Error(`invalid task_plan: step ${position + 1} needs a non-empty \`title\` and \`detail\``)
    }
    const dependsOn = (step.depends_on ?? []).map(Number)
    for (const ref of dependsOn) {
      if (!Number.isInteger(ref) || ref < 1 || ref > raw.steps.length || ref === position + 1) {
        throw new Error(
          `invalid task_plan: step ${position + 1} has an invalid \`depends_on\` reference ${JSON.stringify(ref)}`
            + ` (valid references: 1-${raw.steps.length}, excluding itself)`,
        )
      }
    }
    return { index: position + 1, title, detail, depends_on: [...new Set(dependsOn)].sort((a, b) => a - b) }
  })
  const pluginRows = (raw.plugins ?? []).map((plugin, position) => {
    const name = typeof plugin.name === 'string' ? plugin.name.trim() : ''
    const purpose = typeof plugin.purpose === 'string' ? plugin.purpose.trim() : ''
    if (name.length === 0 || purpose.length === 0) {
      throw new Error(`invalid task_plan: plugins[${position}] needs non-empty \`name\` and \`purpose\``)
    }
    return { name, purpose }
  })
  return { goal, assumptions, steps, acceptance, risks, pluginRows }
}

/** Build the `task_plan` tool definition as plain, fully standard JSON Schema.
 * The parameters schema is hand-written to the wire format the model API
 * validates (`required` is always a string array, never a boolean) so every
 * registration path — including plan mode's stricter function-schema check —
 * accepts it without a compiler step. */
function buildPlanTool(getCatalog, maxCatalogEntries) {
  const description = 'Decompose the current user request into a structured execution plan before starting '
    + 'non-trivial work: goal, assumptions, ordered steps with dependencies, the installed plugins the task '
    + 'will rely on (chosen from the available-plugins directory; built-in tools and skills are already '
    + 'visible and need no entry), and acceptance criteria. Skip it for simple questions answerable in one '
    + 'step. After a successful plan, sync the steps with `todo_write`.'
  const parameters = {
    type: 'object',
    additionalProperties: false,
    properties: {
      goal: {
        type: 'string',
        description: 'What the request must achieve, in one sentence.',
      },
      assumptions: {
        type: 'array',
        description: 'Assumptions or open questions about ambiguous requirements; omit when the request is fully specified.',
        items: { type: 'string' },
      },
      plugins: {
        type: 'array',
        description: 'Installed plugins this task will rely on, chosen from the available-plugins directory provided with the request; omit when none is needed. Built-in tools and skills are already visible to you and must not be listed here.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'Exact plugin name from the available-plugins directory.' },
            purpose: { type: 'string', description: 'Why this task needs this plugin.' },
          },
          required: ['name', 'purpose'],
        },
      },
      steps: {
        type: 'array',
        description: 'Ordered execution steps; step numbers are their 1-based indexes.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', description: 'Short imperative step name.' },
            detail: { type: 'string', description: 'What to do in this step and how the result is verified.' },
            depends_on: {
              type: 'array',
              description: '1-based indexes of steps that must complete first; omit for an independent step.',
              items: { type: 'integer', minimum: 1 },
            },
          },
          required: ['title', 'detail'],
        },
      },
      acceptance: {
        type: 'array',
        description: 'Observable outcomes that verify the finished work; one item per criterion.',
        items: { type: 'string' },
      },
      risks: {
        type: 'array',
        description: 'Known risks or caveats; omit when there are none.',
        items: { type: 'string' },
      },
    },
    required: ['goal', 'steps', 'acceptance'],
  }
  const outputValueSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      goal: { type: 'string' },
      assumptions: { type: 'array', items: { type: 'string' } },
      plugins: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, purpose: { type: 'string' } } } },
      unknownPlugins: { type: 'array', items: { type: 'string' } },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            title: { type: 'string' },
            detail: { type: 'string' },
            depends_on: { type: 'array', items: { type: 'integer' } },
          },
        },
      },
      acceptance: { type: 'array', items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'string' } },
    },
  }

  /** Resolve recognized plugin names and flag the rest, against the live catalog. */
  const resolvePlugins = (pluginRows) => {
    if (pluginRows.length === 0) return { plugins: [], unknownPlugins: [] }
    // readCatalog never throws; an unavailable catalog yields an empty `known`.
    const known = getCatalog().known
    if (known.size === 0) {
      // No catalog available: keep the rows without flagging anything.
      return { plugins: pluginRows, unknownPlugins: [] }
    }
    // Scoped package names must appear in the catalog; short unscoped names
    // (skills and built-in tool packages that reach the model by another
    // surface, such as the skill catalog) are accepted as-is.
    const matchesCatalog = (name) => known.has(name) || !name.startsWith('@')
    const plugins = pluginRows.filter(plugin => matchesCatalog(plugin.name))
    const unknownPlugins = pluginRows
      .filter(plugin => !matchesCatalog(plugin.name))
      .map(plugin => plugin.name)
    return { plugins, unknownPlugins }
  }

  const canonicalValue = (args) => {
    const plan = toCanonicalPlan(args)
    const { plugins, unknownPlugins } = resolvePlugins(plan.pluginRows)
    return {
      goal: plan.goal,
      assumptions: plan.assumptions,
      plugins,
      unknownPlugins,
      steps: plan.steps,
      acceptance: plan.acceptance,
      risks: plan.risks,
    }
  }

  // Registered directly as a plain definition: the parameters are already the
  // exact wire schema, so no spec compiler sits between here and the model API.
  return {
    name: 'task_plan',
    description,
    parameters,
    output: {
      schema: outputValueSchema,
      render: (_args, value) => renderPlan(value),
    },
    isConcurrencySafe: () => false,
    execute: args => Promise.resolve(canonicalValue(args)),
    presentCall: args => ({ card: 'generic', title: 'Record task plan', kind: 'other', rawInput: args }),
  }
}

/** Build one identified user-role message, preferring the host factory. */
async function buildMessageFactory() {
  try {
    const { createUserMessage } = await importHostPackage('@deepseek-ai/dsh-llm')
    return (text) => createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'task-planner/guidance' },
    })
  } catch {
    // Fallback: the host id format is a plain UUID string.
    return (text) => ({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'task-planner/guidance' },
    })
  }
}

/**
 * Register the planning tool, the system-prompt policy, and the start-of-turn reminder.
 * @param ctx - registrant context carrying the tool and system-prompt registries.
 * @param config - validated plugin configuration (defaults applied when absent).
 */
export async function apply(ctx, config) {
  // The loader already validated through Config; normalize again only to be
  // robust when no schema export is honored.
  const resolved = normalizeConfig(config)
  if (!resolved.enabled) return
  ctxCatalog = ctx

  const planTool = buildPlanTool(readCatalog, resolved.maxCatalogEntries)
  const buildMessage = await buildMessageFactory()

  ctx.tools.register(planTool)

  ctx.systemPrompt.section({
    name: 'task-planner:policy',
    order: 490,
    text: resolved.policyText,
    interpolate: false,
  })

  if (resolved.pluginCatalog) {
    // Publish the plugin directory through the runtime-context snapshot instead
    // of the per-turn reminder: the host projection keeps a single rolling
    // snapshot message and only appends a new one when a section's text
    // changes, so an unchanged catalog costs no per-turn context. The text
    // function is evaluated per step against the live inventory and memoized
    // per (catalog fingerprint, entry cap), keeping the rendered string stable
    // while the catalog is unchanged.
    const catalogText = () => {
      const catalog = readCatalog()
      if (catalog.suffix === undefined || catalog.maxEntries !== resolved.maxCatalogEntries) {
        catalog.suffix = renderCatalog(catalog.rows, resolved.maxCatalogEntries)
        catalog.maxEntries = resolved.maxCatalogEntries
      }
      return catalog.suffix
    }
    ctx.systemPrompt.context({
      name: 'task-planner:catalog',
      order: 130,
      interpolate: false,
      text: () => catalogText(),
    })
  }

  if (resolved.nudgeOnNewTurn) {
    // One reminder per agent turn: keyed by turn number so follow-up steps and
    // resumed sessions never repeat it inside the same turn. The default text
    // is a single pointer line (see DEFAULT_NUDGE_TEXT); a custom `nudgeText`
    // is used verbatim and is the operator's context-cost trade-off.
    const nudgedTurns = new WeakMap()
    ctx.effect(() => () => nudgedTurns.clear(), 'task-planner.nudgedTurns')
    ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next) => {
      const decision = await next()
      try {
        if (decision.kind === 'reject') return decision
        if (step !== 1 || messages.length === 0) return decision
        let nudged = nudgedTurns.get(agent)
        if (nudged === undefined) {
          nudged = new Set()
          nudgedTurns.set(agent, nudged)
        }
        if (nudged.has(turn)) return decision
        nudged.add(turn)
        const nudge = buildMessage(resolved.nudgeText)
        // Fold the reminder right after the claimed user input, before the
        // driver-appended runtime context, mirroring the loop's own ordering.
        const claimed = new Set(messages)
        const lastClaimedIndex = decision.messages.findLastIndex(message => claimed.has(message))
        const entered = lastClaimedIndex >= 0
          ? decision.messages.toSpliced(lastClaimedIndex + 1, 0, nudge)
          : [...decision.messages, nudge]
        return { ...decision, messages: entered }
      } catch (error) {
        ctx.logger?.warn?.('task-planner reminder failed; entering the step unchanged: %o', error)
        return decision
      }
    })
  }
}
