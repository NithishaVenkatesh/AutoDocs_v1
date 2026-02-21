diff --git a/README.md b/README.md
index d0825a6a47768c036c2cf16be5deecb30611c4de..5a900ce77624a2a6c3d5dae2d503534db228ee5b 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,149 @@
-# AutoDocs
\ No newline at end of file
+# AutoDocs
+
+AutoDocs is a documentation-focused project built around a web dashboard for repository management and documentation viewing, plus utility scripts for database setup and computer-vision experimentation.
+
+At a high level, the project combines:
+- A **Next.js UI layer** for repository and documentation interactions.
+- A **Neon/Postgres data layer** for persisted repositories and generated documentation chunks.
+- A set of **support scripts** for bootstrapping database tables and running local CV experiments.
+
+---
+
+## Architecture Overview
+
+### 1) Presentation Layer (Next.js)
+
+The frontend centers around two page-level modules:
+
+- `page.js` (dashboard, client component):
+  - Fetches available GitHub repositories and saved repositories.
+  - Supports saving/removing repositories.
+  - Provides search, status cards, and “generate/view docs” interactions.
+  - Uses UI building blocks like `Sidebar`, `Topbar`, and `RepositoryCard`.
+
+- `page.tsx` (documentation detail page, server component):
+  - Uses Clerk auth on the server to identify the user.
+  - Loads documentation and chunked content from Neon/Postgres.
+  - Renders repository metadata and chunk HTML for a selected documentation record.
+
+Together, these pages form a flow from **repo selection** → **documentation generation lifecycle** → **documentation consumption**.
+
+### 2) Data Layer (Neon/Postgres)
+
+The app uses `@neondatabase/serverless` clients to run SQL queries against Postgres.
+
+Current repository includes direct SQL access patterns for:
+- **`repos`** (created by script) — stores selected repositories mapped to Clerk users.
+- **`documentation`** and **`documentation_chunks`** (queried in docs page) — stores generated docs and chunked content sections.
+
+This schema supports per-user data isolation and scalable rendering of large documentation bodies via chunking.
+
+### 3) Utility / Operational Scripts
+
+- `create-table.js`:
+  - Loads environment variables from `.env`.
+  - Connects to Neon/Postgres.
+  - Creates the `repos` table if it does not exist.
+
+- `main.py`:
+  - Runs a local webcam loop.
+  - Detects yellow regions in HSV color space.
+  - Displays original feed, mask, and masked result windows.
+
+`main.py` is functionally independent from the Next.js stack and appears intended for experimentation/prototyping.
+
+---
+
+## Request/Rendering Flow
+
+1. User lands on the dashboard (`page.js`).
+2. Dashboard fetches:
+   - available GitHub repos (`/api/github`), and
+   - persisted repos (`/api/repos`).
+3. User saves/removes repos via API endpoints (`/api/repos/select`, `/api/repos/:id`).
+4. User navigates to documentation view.
+5. Server page (`page.tsx`) validates auth and queries:
+   - documentation + repository metadata,
+   - documentation chunks ordered by chunk index.
+6. UI renders chunked documentation content.
+
+---
+
+## Repository Structure
+
+```text
+.
+├── README.md              # Project overview and architecture
+├── page.js                # Client dashboard for repository/documentation workflows
+├── page.tsx               # Server documentation detail page
+├── create-table.js        # Database bootstrap script for `repos`
+├── main.py                # OpenCV yellow-color detection experiment
+└── next.config.ts         # Next.js configuration
+```
+
+---
+
+## Local Setup
+
+### Prerequisites
+
+- Node.js 18+
+- npm (or equivalent package manager)
+- Python 3.9+ (for `main.py`)
+- Access to a Postgres/Neon database
+
+### Environment Variables
+
+Create a `.env` file with at least:
+
+```bash
+DATABASE_URL=postgres://<user>:<password>@<host>/<db>?sslmode=require
+```
+
+> Add Clerk and GitHub-related variables required by your broader app setup if your local runtime depends on them.
+
+### Install dependencies
+
+For JavaScript/TypeScript runtime:
+
+```bash
+npm install
+```
+
+For Python script:
+
+```bash
+pip install opencv-python numpy
+```
+
+### Initialize database table
+
+```bash
+node create-table.js
+```
+
+### Run app
+
+```bash
+npm run dev
+```
+
+Open `http://localhost:3000`.
+
+---
+
+## Notes on Current Design
+
+- The codebase currently mixes both `.js` and `.tsx` page files at repository root level.
+- The dashboard includes placeholder documentation-generation behavior (simulated delay) and can be wired to a production generation API.
+- Documentation rendering currently relies on HTML content insertion (`dangerouslySetInnerHTML`), so sanitation/trust boundaries should be reviewed in production.
+
+---
+
+## Suggested Next Improvements
+
+- Consolidate route/file layout under standard Next.js `app/` (or `pages/`) structure.
+- Add migration files for all tables (`documentation`, `documentation_chunks`, `repos`) to keep schema versioned.
+- Move raw SQL access into a small data-access layer for better testability.
+- Add automated tests for dashboard data-fetch and docs-page query behavior.
+- Add content sanitation/validation pipeline for generated doc chunks.
