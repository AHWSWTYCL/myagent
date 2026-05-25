import { AgentDefinition } from '../definition.js'
import { exploreAgent } from './explore.js'
import { plannerAgent } from './planner.js'
import { generatorAgent } from './generator.js'
import { verifierAgent } from './verifier.js'
import { coordinatorAgent } from './coordinator.js'
import { generalPurposeAgent } from './general.js'
import { analystAgent } from './analyst.js'
import { bugIntakeAgent } from './bug_intake.js'

export const builtinAgents: AgentDefinition[] = [
  analystAgent,
  bugIntakeAgent,
  exploreAgent,
  plannerAgent,
  generatorAgent,
  verifierAgent,
  coordinatorAgent,
  generalPurposeAgent,
]
