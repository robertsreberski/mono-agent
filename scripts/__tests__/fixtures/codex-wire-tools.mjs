// Pi 1.4+ emits function declarations as developer additional_tools input items.
// Tests observe both native layouts; production guards validate every container.
export const codexWireTools = body => [...(body.tools ?? []), ...(body.input ?? [])
  .filter(item => item.type === "additional_tools").flatMap(item => item.tools)];
