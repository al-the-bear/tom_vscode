# Mermaid Diagram Types

> Reference document showing all diagram types supported by Mermaid and their potential for the YAML Graph Editor.

---

## Currently Supported

These diagram types are implemented in the YAML Graph Editor:

### 1. Flowchart

Process flows, decision trees, workflows.

```mermaid
flowchart TD
    A[Start] --> B{Decision?}
    B -->|Yes| C[Process 1]
    B -->|No| D[Process 2]
    C --> E[End]
    D --> E
```

**Shapes:** rectangle, diamond, stadium, subroutine, circle, hexagon, parallelogram, trapezoid, cylinder, asymmetric, double-circle

**Use cases:** Business processes, algorithms, user flows, deployment pipelines

---

### 2. State Diagram

Lifecycle states, finite state machines, object states.

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Submitted: submit
    Submitted --> Approved: approve
    Submitted --> Rejected: reject
    Approved --> [*]
    Rejected --> Draft: revise
```

**Special states:** `[*]` for start/end, fork, join, choice

**Use cases:** Order lifecycles, document workflows, UI states, protocol states

---

### 3. ER Diagram

Database schemas, entity relationships.

```mermaid
erDiagram
    Customer ||--o{ Order : places
    Order ||--|{ LineItem : contains
    Product ||--o{ LineItem : "ordered in"
    
    Customer {
        int id PK
        string name
        string email UK
    }
    Order {
        int id PK
        int customer_id FK
        date created
    }
```

**Cardinalities:** one-to-one (`||--||`), one-to-many (`||--o{`), many-to-many (`}o--o{`)

**Use cases:** Database design, data models, API resource relationships

---

## Potential Future Support

These diagram types could be added to the YAML Graph Editor:

### 4. Gantt Chart

Project timelines, schedules, resource planning.

```mermaid
gantt
    title Project Schedule
    dateFormat YYYY-MM-DD
    
    section Planning
    Requirements     :a1, 2026-01-01, 14d
    Design           :a2, after a1, 7d
    
    section Development
    Phase 1          :b1, after a2, 21d
    Phase 2          :b2, after b1, 21d
    
    section Testing
    QA               :c1, after b2, 14d
    UAT              :c2, after c1, 7d
```

**Key features:** Dependencies, milestones, sections, date ranges

**YAML schema complexity:** Medium — linear task list with dependencies

---

### 5. Sequence Diagram

API calls, message flows, protocol sequences.

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant Database
    
    Client->>API: POST /orders
    API->>Database: INSERT order
    Database-->>API: order_id
    API-->>Client: 201 Created
    
    Note over API,Database: Transaction boundary
```

**Key features:** Participants, messages, notes, loops, alternatives

**YAML schema complexity:** High — nested control flow blocks

---

### 6. Class Diagram

OOP design, UML classes, inheritance hierarchies.

```mermaid
classDiagram
    class Animal {
        +String name
        +int age
        +makeSound()
    }
    class Dog {
        +fetch()
    }
    class Cat {
        +scratch()
    }
    
    Animal <|-- Dog
    Animal <|-- Cat
```

**Key features:** Classes, attributes, methods, relationships (inheritance, composition, aggregation)

**YAML schema complexity:** High — nested class definitions with visibility modifiers

---

### 7. Pie Chart

Simple data visualization.

```mermaid
pie title Browser Market Share
    "Chrome" : 65
    "Safari" : 19
    "Firefox" : 4
    "Edge" : 4
    "Other" : 8
```

**Key features:** Segments with values, optional title

**YAML schema complexity:** Low — simple key-value list

---

### 8. Mindmap

Hierarchical brainstorming, topic organization.

```mermaid
mindmap
  root((Project))
    Features
      Core
      Extensions
    Timeline
      Q1
      Q2
    Team
      Dev
      QA
```

**Key features:** Hierarchical nodes, shapes per level

**YAML schema complexity:** Medium — tree structure with optional shapes

---

### 9. Timeline

Historical events, roadmaps.

```mermaid
timeline
    title Product Roadmap
    2024 : MVP Launch
         : Core Features
    2025 : Scale
         : Enterprise Features
    2026 : Expansion
         : Global Rollout
```

**Key features:** Time periods with events

**YAML schema complexity:** Low — simple period-event mapping

---

### 10. Git Graph

Branch visualization, merge strategies.

```mermaid
gitGraph
    commit
    branch develop
    checkout develop
    commit
    commit
    checkout main
    merge develop
    commit
```

**Key features:** Commits, branches, merges, cherry-picks

**YAML schema complexity:** High — ordered operations with branch context

---

### 11. Quadrant Chart

Strategic positioning, priority matrices.

```mermaid
quadrantChart
    title Reach vs Effort
    x-axis Low Effort --> High Effort
    y-axis Low Reach --> High Reach
    quadrant-1 Quick Wins
    quadrant-2 Major Projects
    quadrant-3 Fill-ins
    quadrant-4 Maybe Later
    
    Campaign A: [0.3, 0.8]
    Campaign B: [0.7, 0.9]
    Campaign C: [0.2, 0.3]
```

**Key features:** Axis labels, quadrant names, positioned items

**YAML schema complexity:** Medium — coordinate-based positioning

---

### 12. Sankey Diagram

Flow quantities, resource distribution.

```mermaid
sankey-beta
    Energy,Electricity,50
    Energy,Heat,30
    Energy,Transport,20
    Electricity,Industry,25
    Electricity,Residential,25
```

**Key features:** Source → target with quantity

**YAML schema complexity:** Low — simple tuple list

---

### 13. XY Chart

Line/bar charts, data visualization.

```mermaid
xychart-beta
    title "Sales Trend"
    x-axis [Jan, Feb, Mar, Apr, May]
    y-axis "Revenue" 0 --> 100
    line [30, 45, 60, 75, 90]
    bar [25, 40, 55, 70, 85]
```

**Key features:** Axes, multiple series, line/bar types

**YAML schema complexity:** Medium — series data with axis configuration

---

### 14. Requirement Diagram

Requirements engineering, traceability.

```mermaid
requirementDiagram

requirement high_availability {
id: REQ-001
text: System must achieve 99.9% uptime
risk: high
verifymethod: test
}

element load_balancer {
type: component
}

load_balancer - satisfies -> high_availability
```

**Key features:** Requirements, elements, relationships (derives, satisfies, verifies)

**YAML schema complexity:** High — typed nodes with semantic relationships

---

### 15. Block Diagram (Beta)

System architecture, component layouts.

```mermaid
block-beta
    columns 3
    
    block:Frontend
        A["Web App"]
        B["Mobile App"]
    end
    
    space
    
    block:Backend
        C["API Gateway"]
        D["Services"]
    end
```

**Key features:** Columns, blocks, nested groups, connections

**YAML schema complexity:** High — nested block structure with layout

---

## Recommended Prioritization

| Priority | Diagram Type | Rationale |
|----------|-------------|-----------|
| **High** | Gantt | Common project use, straightforward schema |
| **High** | Sequence | Essential for API/protocol documentation |
| **Medium** | Class | Useful for OOP design, complex schema |
| **Medium** | Mindmap | Good for brainstorming, simple schema |
| **Low** | Pie/Timeline | Simple but limited use cases |
| **Low** | Git Graph | Niche use, complex rendering |
| **Experimental** | Sankey, XY Chart, Requirement | Beta features, may change |

---

## Schema Pattern Observations

**Simple patterns** (easy to support):
- Key-value lists (Pie, Sankey)
- Linear task lists (Gantt, Timeline)
- Tree structures (Mindmap)

**Complex patterns** (harder to support):
- Nested control flow (Sequence — loops, alternatives)
- Ordered operations (Git Graph)
- Coordinate positioning (Quadrant)
- Attribute visibility modifiers (Class)

**Recommendation:** Start with Gantt and Mindmap as they have the best complexity-to-utility ratio.
