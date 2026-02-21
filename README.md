# AutoDocs System Design
AutoDocs is a web-based documentation orchestration system built using Next.js, Clerk authentication, and Neon Postgres. The application enables users to select GitHub repositories, persist them, and render structured documentation generated from repository data.

## Core Responsibilities

### Repository Management

- Fetch repositories from GitHub  
- Persist selected repositories to Postgres  
- Delete repositories  
- Trigger documentation generation workflows  

### Documentation Rendering

- Authenticate user via Clerk  
- Enforce repository ownership checks  
- Retrieve documentation metadata  
- Retrieve ordered documentation chunks  
- Render structured HTML output
  
### 1) Current files and responsibilities

- `page.js`: Client-side dashboard to fetch GitHub repositories, persist selected repositories, and trigger/view documentation workflows through API endpoints. It also drives stateful UI (loading, success/error toasts, filtering, cards).  
- `page.tsx`: Server component for documentation detail pages with Clerk auth checks and Neon database reads (`documentation`, `repos`, and `documentation_chunks` joins/queries).  
- `create-table.js`: One-off script that provisions the `repos` table in Neon/Postgres.  
- `next.config.ts`: Basic Next.js config scaffold (no active customization).  
- `main.py`: Standalone OpenCV live webcam processing loop for yellow object segmentation.  

```mermaid
flowchart LR
    U[End User] --> W[Next.js Dashboard\npage.js]
    W --> A1[/api/github/]
    W --> A2[/api/repos/]
    W --> A3[/api/repos/select/]
    W --> A4[/api/repos/:id DELETE/]
    W --> A5[/api/repos/:id/generate-docs/]

    A1 --> G[GitHub API]
    A2 --> D[(Neon Postgres)]
    A3 --> D
    A4 --> D
    A5 --> D

    U --> P[Docs Page\npage.tsx]
    P --> C[Clerk Auth]
    P --> D

    X[main.py OpenCV pipeline] -. standalone .-> Cam[(Local Webcam)]
```

## 2) Runtime Component Design

```mermaid
flowchart TB
    subgraph Frontend["Client Runtime"]
      DASH["Dashboard Component - React state + handlers"]
      RC["RepositoryCard"]
      SB["Sidebar"]
      TB["Topbar"]
    end

    subgraph Server["Next.js Server Runtime"]
      DOC["Documentation Page - Auth + SQL queries"]
      API["API Handlers - referenced, not in snapshot"]
    end

    subgraph Data["Data Layer"]
      PG[("Neon Postgres")]
      GH["GitHub REST API"]
      CL["Clerk"]
    end

    DASH --> API
    DASH --> RC
    DASH --> SB
    DASH --> TB

    DOC --> CL
    DOC --> PG

    API --> PG
    API --> GH
```

---

## 3) Primary Request Flows

### A) Save repository flow

```mermaid
sequenceDiagram
    participant User
    participant Dashboard as page.js
    participant API as /api/repos/select
    participant DB as Neon Postgres

    User->>Dashboard: Click save/add repo
    Dashboard->>API: POST {repo}
    API->>DB: INSERT/UPSERT repo row
    DB-->>API: saved row
    API-->>Dashboard: {repo}
    Dashboard->>Dashboard: optimistic state update
    Dashboard->>API: GET /api/repos (refresh consistency)
```

### B) View documentation flow

```mermaid
sequenceDiagram
    participant User
    participant Dashboard as page.js
    participant DocsPage as page.tsx
    participant Clerk
    participant DB as Neon Postgres

    User->>Dashboard: Click "View Docs"
    Dashboard->>DocsPage: Route push /docs/{repoName}
    DocsPage->>Clerk: auth()
    Clerk-->>DocsPage: userId
    DocsPage->>DB: SELECT documentation + repo ownership
    DocsPage->>DB: SELECT documentation_chunks ORDER BY chunk_index
    DB-->>DocsPage: row sets
    DocsPage-->>User: rendered HTML chunks
```
### High-level target architecture

```mermaid
flowchart LR
    U[User] --> FE[Next.js Frontend]
    FE --> BFF[API/BFF Layer]
    BFF --> AUTH[Clerk]
    BFF --> DB[(Postgres)]
    BFF --> GH[GitHub API]

    BFF --> Q[Job Queue]
    Q --> W[Doc Generation Worker]
    W --> DB
    W --> OBJ[(Object Storage for large artifacts)]

    OBS[Logging + Metrics + Tracing] --- FE
    OBS --- BFF
    OBS --- W
```
