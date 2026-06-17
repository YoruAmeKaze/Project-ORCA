# ORCA SYSTEM DESIGN MEMORY PACK v1.0

## 1. Project Definition

Orca is a persistent, skill-driven agent runtime system designed to operate on a workstation environment, with future expansion into cloud and IoT control.

It is NOT a chatbot. It is an execution-oriented agent system.

Core idea:
- LLM = planner
- DSL = behavior representation
- Runtime = deterministic executor
- Skill = atomic capability unit

---

## 2. Core Architecture

Orca system consists of 5 layers:

### (1) LLM Layer (Planner)
- Converts user intent → structured DSL
- Does NOT execute actions
- Does NOT directly call tools

---

### (2) DSL Layer (Behavior Language)
- Represents execution plan
- Linear structure (MVP)
- Optional condition extension later

Example:
```yaml
steps:
  - skill: read_file
    args:
      path: /notes.txt
  - skill: summarize_text
  - skill: send_message
```

### (3) Validator / Compiler Layer

#### Responsibilities:

* Validate skill existence
* Validate argument schema
* Check permission level
* Optionally auto-repair DSL

⸻

### (4) Runtime Engine

* Deterministic executor
* Executes DSL step-by-step
* No reasoning logic
* Only dispatches skills

#### Pseudo:
for step in DSL:
execute(skill_registry[step.skill], step.args)

⸻

### (5) Skill Registry (Core Capability Layer)

#### Skill is the ONLY executable unit.

#### Skill definition:

* name
* input_schema
* handler function
* permission level

#### Example skills:

* read_file(path)
* write_file(path, content)
* send_message(content)
* run_command(cmd)

#### IMPORTANT:
Skills are PREDEFINED. LLM cannot invent new executable skills.

## 3. Skill Selection Mechanism

#### Skill selection process:

1. Retrieve candidate skills (keyword / embedding)
2. Filter by:
    * permission
    * environment availability
    * schema compatibility
3. LLM selects from constrained candidate set
4. Output structured DSL

#### Key rule:
LLM cannot freely generate skill names outside registry.

⸻

## 4.Skill Abstraction Rules

MVP Rule:

Skill MUST be function-level atomic unit.

NOT allowed:

* task-level skills as execution unit

Allowed:

* composite skills (as DSL templates only)

Composite skill = reusable DSL, NOT new runtime capability.

⸻

## 5.Autonomy Model (Proactive System)

#### Orca has 4-level autonomy:

Level 0: passive execution only
Level 1: notifications only
Level 2: suggestions only
Level 3: requires user confirmation
Level 4: auto execution (restricted skills only)

⸻

#### Trigger conditions:

* idle detection
* system events
* contextual inactivity
* schedule-based triggers

⸻

## 6.Design Principles

* Deterministic execution > AI freedom
* Skill registry is closed world
* DSL is strict schema, not free text
* LLM is planner only, never executor
* System correctness > model intelligence

⸻

## 7.Phase Evolution Plan

Phase 1: Core Agent (MVP)

* function-level skills
* linear DSL
* basic runtime
* no autonomy

Phase 2: Workflow Agent

* conditional DSL
* reusable workflows
* basic memory

Phase 3: Persistent Agent

* attention system
* idle detection
* suggestion engine

Phase 4: Environment Agent

* workstation integration
* cloud APIs
* IoT adapters

Phase 5: Orca (Final Form)

* proactive behavior system
* memory-driven actions
* semi-autonomous execution
* multi-device orchestration

⸻

## 8.Key Design Conclusion

#### Orca is NOT:

* not a free-form generative agent
* not self-modifying runtime

#### Orca IS:

* constrained execution system
* skill-based deterministic engine
* LLM-driven planner with strict boundaries

⸻

## 9.Critical Constraint Summary

* Skill = function-level only
* DSL = structured execution plan
* Runtime = deterministic executor
* LLM = planner only
* No dynamic skill creation at runtime