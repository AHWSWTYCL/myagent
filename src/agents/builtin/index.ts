import { AgentDefinition } from '../definition.js'
import { exploreAgent } from './explore.js'
import { plannerAgent } from './planner.js'
import { generatorAgent } from './generator.js'
import { verifierAgent } from './verifier.js'
import { coordinatorAgent } from './coordinator.js'
import { generalPurposeAgent } from './general.js'
import { analystAgent } from './analyst.js'
import { bugIntakeAgent } from './bug_intake.js'
import { debugExpertAgent } from './debug_expert.js'

export const builtinAgents: AgentDefinition[] = [
  analystAgent,
  bugIntakeAgent,
  debugExpertAgent,
  exploreAgent,
  plannerAgent,
  generatorAgent,
  verifierAgent,
  coordinatorAgent,
  generalPurposeAgent,
]
