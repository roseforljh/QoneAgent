// The composer stores commands as directive nodes. Expand their serialized
// form only when a message is submitted so Pi and the MCP router receive the
// same leading commands they already understand.
const COMMAND_DIRECTIVE = /^:qone-command\[((?:skill|mcp):[^\]\n]+)\](?=\s|$)/u;

export function expandComposerCommand(text: string): string {
  const match = COMMAND_DIRECTIVE.exec(text);
  return match ? `/${match[1]}${text.slice(match[0].length)}` : text;
}
