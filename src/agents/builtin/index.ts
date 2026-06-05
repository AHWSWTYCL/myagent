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
import { projectBuilderAgent } from './project_builder.js'
import { advisorAgent } from './advisor.js'

export const builtinAgents: AgentDefinition[] = [
  analystAgent,
  bugIntakeAgent,
  debugExpertAgent,
  projectBuilderAgent,
  exploreAgent,
  plannerAgent,
  generatorAgent,
  verifierAgent,
  coordinatorAgent,
  generalPurposeAgent,
  advisorAgent,
]
