import { Type } from "typebox";

import { createCoordinationClient } from "../../coordination.mjs";

export default function coordinationExtension(pi) {
  const client = () => createCoordinationClient();

  pi.registerTool({
    name: "agents_list",
    label: "List swarm agents",
    description: "List the agents participating in this swarm and show your own agent identity.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const result = await client().listAgents();
      const lines = result.agents.map((agent) => {
        const details = [agent.status, agent.generation === undefined ? undefined : `generation:${agent.generation}`]
          .filter(Boolean)
          .join(" ");
        return `- ${agent.id}${details ? ` (${details})` : ""}${agent.id === result.self ? " [you]" : ""}`;
      });
      return {
        content: [{ type: "text", text: `You are ${result.self}. ${result.total} top-level agents are registered.\n${lines.join("\n")}` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "messages_read",
    label: "Read swarm messages",
    description: "Read unread group messages and messages addressed to you. Use all=true to inspect recent history without moving your unread cursor.",
    parameters: Type.Object({
      all: Type.Optional(Type.Boolean({ description: "Read recent matching history instead of only unread messages." })),
      limit: Type.Optional(Type.Number({ description: "Maximum messages to return, from 1 to 100." })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const result = await client().readMessages(params);
      return { content: [{ type: "text", text: result.text }], details: result };
    },
  });

  pi.registerTool({
    name: "message_send",
    label: "Send swarm message",
    description: "Send a message to all agents, one agent, or a group. Omit to to broadcast to all agents.",
    parameters: Type.Object({
      body: Type.String({ description: "Complete message body." }),
      to: Type.Optional(Type.Array(Type.String(), { description: "Recipient agent IDs, or ['all']. Defaults to all." })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Short searchable labels such as working, finding, question, or ruled-out." })),
      replyTo: Type.Optional(Type.String({ description: "Message ID being answered." })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const message = await client().sendMessage(params);
      return {
        content: [{ type: "text", text: `Sent message ${message.id} to ${message.to.join(", ")}.` }],
        details: message,
      };
    },
  });
}
