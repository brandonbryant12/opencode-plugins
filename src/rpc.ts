import { Rpc } from "@opencode-ai/plugin/rpc";

// Poll compact counters; retrieve an individual private receipt only on demand.
export const GoalRPC = Rpc.define({
  id: "goal",
  methods: {
    receipt: { input: { type: "object", properties: { key: { type: "string" }, startedAt: { type: ["number", "null"] } }, required: ["key", "startedAt"], additionalProperties: false }, output: { type: "object", properties: { receipt: { type: ["string", "null"] } }, required: ["receipt"], additionalProperties: false } },
    progress: { input: { type: "null" }, output: { type: "object", properties: { progress: { type: ["object", "null"] } }, required: ["progress"], additionalProperties: false } },
  },
  events: {},
});
