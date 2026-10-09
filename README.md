# TimDo V2: Interactive Cloud-Native Project Board

This project is a Next.js application designed to be an interactive, cloud-native project management board. It is an evolution from a static, file-based system to a dynamic, authenticated user experience.

## Table of Contents

1.  [System Overview (V2)](#system-overview-v2)
2.  [Technology Stack](#technology-stack)
3.  [Core Features](#core-features)
4.  [Authentication Flow](#authentication-flow)
5.  [API Design](#api-design)
6.  [Project Structure](#project-structure)
7.  [Testing Strategy](#testing-strategy)
8.  [Getting Started](#getting-started)
9.  [Available Scripts](#available-scripts)

## System Overview (V2)

TimDo V2 provides authenticated users with an interactive board to manage their projects. The system is built on a modern, serverless-first technology stack, designed for scalability and maintainability.

-   **Frontend**: A Next.js application using the App Router, with UI components from the [Mantine](https://mantine.dev/) library.
-   **Client-Side State**: Data fetching and server-state caching are managed by [TanStack Query (React Query)](https://tanstack.com/query/latest).
-   **Authentication**: User identity and access control are handled by [Auth0](https://auth0.com/) and integrated into the application using [NextAuth.js](https://next-auth.js.org/).
-   **Backend API**: The backend is a set of serverless functions running on Cloudflare Workers, interacting with a Cloudflare D1 (SQL) database.
-   **AI Features**: Voice commands are processed by the backend using Groq for transcription and LLM reasoning via LangChain.js.

This architecture provides a secure, interactive, and personalized user experience.

### Working with other people

TimDo started as a one-person tool and is now multi-user. Work lives in workspaces, which hold projects, which hold epics and tasks. You can share a workspace with someone as an owner, admin, member or viewer, and everything they do is attributed to them in an activity log. Life goals stay private to each person. [docs/collaboration.md](docs/collaboration.md) has the model and the full API.

## Technology Stack

-   **Framework**: Next.js (App Router)
-   **UI Library**: Mantine
-   **Authentication**: NextAuth.js with Auth0 Provider
-   **Client-State Management**: TanStack Query (React Query)
-   **Backend**: Cloudflare Workers, Hono, Drizzle ORM
-   **AI**: LangChain.js, Groq API (for transcription and LLM)
-   **Database**: Cloudflare D1
-   **Testing**: Jest, React Testing Library, Vitest, Storybook

## Core Features

-   **User Accounts & Authentication**: Secure user registration and login via Auth0.
-   **Full CRUD Functionality**: Create, read, update, and delete projects.
-   **Drag-and-Drop Interface**: Reorder projects and change their status intuitively.
-   **Optimistic Updates**: UI updates instantly for a fluid user experience.
-   **Voice Commands**: Users can dictate project changes using their voice.
-   **SVG Poster Generation**: Export the project board as a downloadable SVG.

## Authentication Flow

1.  **Login Initiation**: A user clicks the "Sign In" button.
2.  **Redirect to Auth0**: The app redirects the user to the Auth0 Universal Login page.
3.  **Authentication & Callback**: After successful login, Auth0 redirects back. `next-auth` handles the callback, exchanges codes for tokens, and creates a secure session.
4.  **User Provisioning**: The `signIn` callback in NextAuth makes a secure, server-to-server call to the Cloudflare Worker (`/api/v2/users/ensure`) to create a user record in the D1 database if one doesn't already exist.
5.  **Authenticated Access**: The frontend includes a JWT access token in the `Authorization` header for all API requests to the Cloudflare Worker.

## API Design

The API is a RESTful service built with Cloudflare Workers and Hono.

-   **Authentication**: All endpoints are protected by a JWT authentication middleware, except for the internal `users/ensure` endpoint which uses a shared secret.
-   **Projects API (`/api/v2/projects`)**:
    -   `GET /`: Fetches all projects for the authenticated user.
    -   `POST /`: Creates a new project.
    -   `PUT /:id`: Updates a specific project.
    -   `DELETE /:id`: Soft-deletes a project.
    -   `POST /batch-update`: Updates the priority and status of multiple projects after a drag-and-drop operation.
-   **AI API (`/api/v2/ai`)**:
    -   `POST /voice-command`: Accepts an audio file, transcribes it, uses an LLM to determine changes, and returns a list of updated projects.

## Project Structure

```
.
├── app/
│   ├── board/
│   │   └── page.tsx              # The main interactive project board page
│   ├── hooks/
│   │   └── useProjectMutations.ts # React Query mutations for projects
│   └── ...
├── components/
│   ├── VoiceCommand/             # Voice command UI component
│   └── CreateProjectModal/       # Modal for creating new projects
├── workers/
│   ├── src/
│   │   ├── db/
│   │   │   └── schema.ts         # Drizzle ORM database schema
│   │   ├── middleware/
│   │   │   └── auth.ts           # JWT authentication middleware
│   │   ├── routes/               # Hono route definitions (projects, users, ai)
│   │   ├── services/             # Business logic (projectService, userService, aiService)
│   │   └── index.ts              # Worker entry point
│   └── wrangler.toml             # Worker configuration
└── ...
```

## Testing Strategy

-   **Backend (Vitest)**: Unit tests for services mock the database layer to test business logic in isolation.
-   **Frontend (Jest & RTL)**: Component tests use a custom `render` function that wraps components in necessary providers. API calls are mocked using `fetchMock`. User interactions are simulated to test component behavior and state changes.

## Getting Started

Working on the code needs no accounts at all: see [CONTRIBUTING.md](CONTRIBUTING.md) for the local API with demo data and the test suites. To run your own copy for real, with the accounts you need, what they cost and the settings that make it yours, see [docs/running-your-own-instance.md](docs/running-your-own-instance.md). The steps below set up the full web app for development.

1.  **Clone the repository.**
2.  **Install dependencies in both root and worker directories:**
    ```bash
    npm install
    cd workers && npm install && cd ..
    ```
3.  **Set up environment variables:**
    -   Copy `.env.example` to a new file named `.env.local`.
    -   Create a "Regular Web Application" in your [Auth0 Dashboard](https://manage.auth0.com/).
    -   Fill in `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, and `AUTH0_ISSUER` in `.env.local`.
    -   In Auth0, add `http://localhost:3000/api/auth/callback/auth0` to "Allowed Callback URLs" and `http://localhost:3000` to "Allowed Logout URLs".
    -   Generate secrets for `NEXTAUTH_SECRET` and `INTERNAL_API_SECRET` by running `openssl rand -base64 32`.
    -   Get a free API key from [Groq](https://console.groq.com/keys) and add it as `GROQ_API_KEY`.
4.  **Set up Cloudflare D1 Database:**
    -   Run `npx wrangler d1 create timdo-v2-db` and copy the `database_id` into `workers/wrangler.toml`.
    -   Run `cd workers && npm run migrations:generate` to create the initial SQL migration.
    -   Run `npm run migrations:apply:local` to apply the schema to your local D1 database.
5.  **Run the development servers:**
    -   In one terminal, run the Next.js frontend: `npm run dev`
    -   In another terminal, run the Cloudflare Worker backend: `cd workers && npm run dev`
6.  Open [http://localhost:3000](http://localhost:3000) in your browser.

## Available Scripts

-   `dev`: Starts the Next.js development server.
-   `build`: Creates a production build.
-   `test`: Runs all frontend tests.
-   `workers:dev`: Starts the Cloudflare Worker development server.
-   `workers:test`: Runs all backend tests.
-   `workers:migrations:generate`: Creates a new database migration based on schema changes.
-   `workers:migrations:apply:local`: Applies migrations to the local D1 database.

## Licence

TimDo is free software, released under the [GNU Affero General Public License v3.0 or later](LICENSE). If you run a modified version as a service, the AGPL asks you to offer its source to the people using it.
