# App-server protocol UI coverage

Baseline: Codex `0.149.1` (`rust-v0.149.1`)  
Manifest: 153 client requests, 11 server requests, 77 server notifications

This document records what a person sees, rather than only whether a protocol method is parsed. A method is intentionally not given a dialog when it is a background query, stream update, or state synchronization event.

## Server requests: complete interaction matrix

| Method | Handling | User-facing presentation |
| --- | --- | --- |
| `item/commandExecution/requestApproval` | Interactive | Inline approval above the composer; command, directory, parsed actions, network target, added permissions and proposed persistent rules are summarized before the decision buttons |
| `item/fileChange/requestApproval` | Interactive | Inline approval; reason and requested session write root are shown, followed by one-time/session/reject decisions when supported |
| `item/tool/requestUserInput` | Interactive | Inline question form; option descriptions are retained, keyboard focus enters the first action, and free-text/secret answers use the appropriate input |
| `mcpServer/elicitation/request` | Interactive | Inline typed form, JSON extension form, or confirmed external-browser flow depending on `mode`; external links still pass native confirmation |
| `item/permissions/requestApproval` | Interactive | Inline least-privilege checklist; network and file scopes are rendered as readable rows with turn/session duration choices |
| `applyPatchApproval` | Interactive, legacy | Same file-change approval surface with legacy decision mapping |
| `execCommandApproval` | Interactive, legacy | Same command approval surface with legacy decision mapping |
| `currentTime/read` | Automatic | No dialog; returns local time because it has no side effect or user decision |
| `item/tool/call` | Safe reject | Inline unsupported-capability warning and explicit safe-reject action |
| `account/chatgptAuthTokens/refresh` | Safe reject | Inline unsupported-capability warning; tokens are never rendered and sensitive fallback fields are redacted |
| `attestation/generate` | Safe reject | Inline unsupported-capability warning and explicit safe-reject action |

All 11 methods are covered by an explicit policy. Unknown future methods also fail closed instead of being auto-approved.

## Client requests used by the product

The app-server manifest contains a broad platform API. Codex Pane invokes only the methods that have a complete end-user flow; unused platform APIs are not exposed as inert buttons.

| User flow | Methods | Presentation |
| --- | --- | --- |
| Startup and capability discovery | `model/list`, `account/read`, `account/rateLimits/read`, `account/usage/read`, `config/read`, `permissionProfile/list`, `collaborationMode/list` | Title-bar connection state, model/effort selectors, status line, `/status`, and recoverable notices |
| Conversation lifecycle | `thread/start`, `thread/resume`, `thread/list`, `thread/turns/list`, `thread/unsubscribe`, `thread/name/set` | Pane conversation, session drawer/sidebar, loading state, rename feedback |
| Turn lifecycle | `turn/start`, `turn/steer`, `turn/interrupt` | Send/append/stop controls and running state |
| Settings and work modes | `thread/settings/update` | Model, effort, directory, permission, service-tier and plan-mode controls; changes also appear as conversation cards |
| Context and review | `thread/compact/start`, `review/start` | `/compact`, `/review`, progress/tool cards and context status |
| Goals | `thread/goal/get`, `thread/goal/set`, `thread/goal/clear` | `/goal` card plus compact live status |
| Skills and files | `skills/list`, `fuzzyFileSearch` | Searchable `@` Skill menu and `$` working-directory file menu |
| MCP | `mcpServerStatus/list`, `mcpServer/oauth/login` | `/mcp` inventory card, login browser handoff, completion/failure notice |
| Background terminals and agents | `thread/backgroundTerminals/list`, `thread/backgroundTerminals/terminate`, `thread/list` | `/ps`, `/stop`, `/agents` cards and actionable status-line counters |

The remaining manifest client methods are platform capabilities not implemented by this desktop client (for example plugin marketplace administration, realtime audio, remote control, project mutation, raw filesystem mutation, and Windows sandbox setup). They require a dedicated product flow, permissions model, and recovery design before exposure.

## Notifications and conversation presentation

| Notification class | Visible result |
| --- | --- |
| `item/started`, `item/completed` | Typed conversation cards for messages, reasoning, plans, commands, file changes, MCP/dynamic tools, web search, images, review mode and collaboration agents |
| Message/reasoning/plan/command/file deltas | Batched streaming content inside the existing item; no duplicate toast or card |
| Turn/thread status | Running/idle/error state, waiting-for-approval/input text, unread state and send/append/stop affordances |
| Token/rate-limit updates | Context warning thresholds and rate-limit labels in the status line |
| Settings/name/goal changes | Persistent pane state plus a compact conversation card when the change is meaningful |
| Auto-approval review | Risk, authorization judgment, rationale and action summary card; strict review becomes a visible approval state |
| MCP/login/global config warnings | Recoverable top-level notice with service-specific copy |
| Thread warnings, model reroute/verification/safety checks | Readable, bounded conversation notice; consecutive updates for the same turn and topic coalesce instead of creating a card flood |
| Environment connection lifecycle | Disconnect and reconnect notices in the affected conversation; the ordinary initial connection is silent |
| Unknown future item type | Generic protocol card labelled with the concrete item type, localized status, bounded/redacted detail fields |
| Transport-only or unrelated platform events | Silent state synchronization, or ignored when Codex Pane did not subscribe to that feature |

## `/`, `@`, and `$` interaction contract

| Input | Result | Keyboard behavior |
| --- | --- | --- |
| `/` | 16 supported commands with description and argument syntax | Arrow keys or `Ctrl+P`/`Ctrl+N` select; `Tab` completes; `Shift+Tab` moves back; `Enter` confirms; `Esc` closes without deleting text |
| `@` | Skills searchable by name or description | Same menu controls; selection inserts the Skill mention at the caret |
| `$` | Files searched relative to the pane working directory, showing name and relative path | Same menu controls; selection adds a visible reference chip and quotes paths containing spaces |

Supported commands: `/agents`, `/cd`, `/compact`, `/fast`, `/goal`, `/mcp`, `/new`, `/permissions`, `/plan`, `/ps`, `/rename`, `/resume`, `/review`, `/skills`, `/status`, `/stop`. Legacy aliases remain accepted by the store but are not duplicated in the menu.

Composer behavior follows terminal expectations: `Enter` sends only when the visible Send/Append action is enabled, `Shift+Enter` inserts a newline, Up/Down at the text boundary recalls submitted prompts while preserving the current draft, and an empty Down still returns the transcript to the latest item. History survives switching workspace modes through a bounded in-memory cache and is not persisted to disk.

## Workspace keyboard model

| Shortcut | Action |
| --- | --- |
| `Alt+Arrow` | Move focus spatially between panes, matching the visible split layout |
| `Alt+1` … `Alt+6` | Focus the numbered pane directly |
| `Ctrl+Shift+M` | Switch without data loss between multi-pane and session-sidebar modes |
| `Ctrl+Shift+B` | Collapse or expand the session sidebar |
| `Ctrl+Shift+L` | Open the sidebar and focus session search |
| Session list `↑` / `↓`, `Home` / `End` | Move through sessions without leaving the list |
| Session list `Esc` | Return focus to the active conversation |

Pane numbers are displayed only in multi-pane headers. The session-sidebar mode preserves the active conversation and all background panes, so switching modes does not unsubscribe or discard work.
