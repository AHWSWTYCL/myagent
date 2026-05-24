import { AgentDefinition } from '../definition.js'
import { exploreAgent } from './explore.js'
import { plannerAgent } from './planner.js'
import { generatorAgent } from './generator.js'
import { verifierAgent } from './verifier.js'
import { coordinatorAgent } from './coordinator.js'
import { generalPurposeAgent } from './general.js'

export const builtinAgents: AgentDefinition[] = [
  exploreAgent,
  plannerAgent,
  generatorAgent,
  verifierAgent,
  coordinatorAgent,
  generalPurposeAgent,
]
