// Appended to every session's system prompt so the agent knows the canvas exists
// and can read the format without being told each time. Deliberately short: this
// is paid for on every request, so it says where scenes live, minimally what the
// format is, and what a human edit means.

export const CANVAS_PROMPT = `## Canvas scenes

Editable diagrams live in \`.pi/canvas/*.canvas\` in the project. Read and edit them with your normal file tools; the canvas reloads as you write.

One entity per line:

canvas 1
direction TB

node <id> <kind> "<label>" [at x,y] [in <groupId>]
edge <id> -> <id> ["<label>"] [dashed]
ink <id> "<svg-path-d>" [stroke <color>] [width <n>] [archived]

Ink marked archived is a sketch that has already been compiled into nodes; leave it alone. Kinds are roles, not shapes: process, decision, terminator, data, note, group. A node joins a group when its \`in\` names it, and groups nest. Labels must be quoted.

A scene the user edited is a request: make the change the diagram describes. Positions are laid out automatically, so leave \`at\` alone unless asked to place something.

Check a draft with canvas_check before writing it, and prefer canvas_write over raw file writes: it refuses invalid scenes. Fix what the check reports and re-check until clean.

Layout ranks nodes by longest path and draws each group around its members, so keep one rank inside one group, keep edge labels to a couple of words, and put explanations in note nodes instead of on edges.`;
