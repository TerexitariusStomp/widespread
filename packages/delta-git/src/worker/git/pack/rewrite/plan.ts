// Stable public entrypoint for rewrite-planner callers and tests.

export { buildSelection } from "./selection";
export { compactDeadSlots } from "./selectionCompact";
export { buildOutputOrder, canPassthroughSinglePack, computeHeaderLengths } from "./layout";
