import { AgentDefinition } from '../definition.js'

const SYSTEM = `You are a helpful sub-agent. Complete the given task using the tools available to you. ` +
  `Be thorough; the caller cannot see your intermediate steps, only your final summary.`

export const generalPurposeAgent: AgentDefinition = {
  name: 'general-purpose',
  description:
    'Generic delegate agent. Spawn this when a task can be fully delegated and its result summarized back. ' +
    'Has read_file / write_file / list_dir / bash. Prefer specialized agents (explore, planner, generator, verifier) ' +
    'when their description fits the task.',
  systemPrompt: SYSTEM,
  tools: ['read_file', 'write_file', 'list_dir', 'bash'],
  maxTurns: 20,
}
