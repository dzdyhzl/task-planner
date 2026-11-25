# Task planner

Decomposes new requests into structured plans — including the plugins the task will rely on — before the agent starts working.

## What it does

- Adds a **`task_plan` tool**: the agent records a plan with a goal, assumptions, the installed plugins/capabilities the task will rely on, ordered steps (with dependencies), acceptance criteria, and optional risks. The tool validates the structure, checks the named plugins against the live installed-plugin catalog, flags unrecognized names, and returns a normalized plan; because the call is an ordinary tool call, the plan is preserved in the session log.
- Publishes a **plugin capability directory** through the runtime-context snapshot: the names, titles, and descriptions of currently enabled and active plugins, read from the Loader's live plugin inventory. The snapshot is a single rolling message that is only re-sent when its content changes, so an unchanged catalog adds nothing to later turns. The agent picks the `plugins` field from this directory instead of guessing.
- Adds a **task planning policy** to the system prompt: multi-step work, file or command changes, and other non-trivial requests are planned first with `task_plan` — identifying the plugins the task needs — then mirrored to the todo list (`todo_write`) and kept updated; simple questions and greetings are answered directly.
- Adds a **one-line start-of-turn reminder** ahead of each new user input, pointing back to the planning policy exactly when a fresh request arrives. The full planning requirements live only in the system prompt — they are never repeated per turn.

The guidance is advisory: nothing is intercepted, and every registration is cleaned up when the plugin is disabled or removed.

## Behavior

1. The model judges the incoming request. Simple lookups and short questions skip planning.
2. For non-trivial work it calls `task_plan`, naming the plugins it will rely on from the directory. Invalid arguments (empty goal, no steps, invalid `depends_on` references, unnamed plugin purposes) are rejected with a message the model can fix. Plugin names that do not match the live catalog are listed under `unknownPlugins` for the model to correct or drop — the plan itself is not blocked.
3. After a successful plan it syncs the steps with `todo_write` and executes step by step. While planning, it also weighs parallelization: independent steps with no shared write scope can be delegated to multiple subagents started together; steps that write the same files or depend on earlier steps stay sequential via `depends_on`.
4. After finishing a task the policy asks the model to close it out: bring the project's cognition index back into alignment (`cognition_scan` → `cognition_update_entries` / `cognition_remove_entries` until `cognition_verify` is aligned), and if the workspace is not a git repository yet, ask once whether to create one and push, respecting a previously declined answer.

## Configuration

Set fields in your profile's `cordis.patch.yml` on the `task-planner` entry (the user's patch layer survives upgrades):

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Set `false` to stop registering the tool, policy, and reminders. |
| `nudgeOnNewTurn` | `true` | Whether a one-line start-of-turn reminder is injected ahead of new user input. |
| `pluginCatalog` | `true` | Whether the installed-plugin directory is published through the runtime-context snapshot. |
| `maxCatalogEntries` | `200` | Maximum directory rows in the snapshot (0–200). |
| `policyText` | built-in | Replacement text for the system-prompt planning policy. |
| `nudgeText` | built-in | Replacement text for the per-turn reminder. |

```yaml
- update:
    - id: task-planner
      config:
        enabled: true
```

## Limitations

- Guidance-based: the model may still skip planning; nothing is enforced.
- The plugin directory reflects plugins that are enabled **and** actively loaded when the snapshot is assembled; disabled or failed plugins are excluded, and entries without title or description metadata are omitted. A changed catalog (plugin installed, enabled, or stopped) produces one updated snapshot message.
- The default per-turn reminder is a single pointer line (~40 tokens). A custom `nudgeText` is used verbatim and repeats every turn, which is the operator's context-cost trade-off.
- The plan lives in the session log through the tool call itself; the plugin writes no files and appends no custom event types.
- The per-turn reminder appears once per new turn; mid-turn steering is not re-nudged.
