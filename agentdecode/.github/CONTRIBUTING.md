# Contributing to AgentDecode

Thank you for your interest in contributing! This guide will help you get started.

## Prerequisites

- **Node.js 18+** (20 recommended)
- **npm** (comes with Node.js)
- **Supabase account** – required for backend services

## Getting Started

1. **Clone the repository**

   ```bash
   git clone https://github.com/<your-org>/agentdecode.git
   cd agentdecode
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Set up environment variables**

   Copy the example env file and fill in your Supabase credentials:

   ```bash
   cp .env.example .env.local
   ```

4. **Start the dev server**

   ```bash
   npm run dev
   ```

## Development Workflow

1. Create a new branch from `main`:

   ```bash
   git checkout -b feat/my-feature main
   ```

2. Make your changes, keeping commits focused and well-described.

3. Run the full quality check suite before pushing:

   ```bash
   npm run type-check
   npm run lint
   npm run test
   npm run build
   ```

4. Push your branch and open a pull request against `main`.

## Testing

| Command              | Description                          |
| -------------------- | ------------------------------------ |
| `npm run test`       | Run unit tests                       |
| `npm run test:e2e`   | Run end-to-end tests                 |
| `npm run type-check` | TypeScript type checking (`tsc --noEmit`) |

Always ensure all tests pass before submitting a pull request.

## Code Style

- **TypeScript** – all source files should be written in TypeScript.
- **ESLint** – run `npm run lint` to check for style violations. Fix any issues before committing.
- **Structured logging** – use the project's `logger` utility instead of `console.log` for runtime logging.

## Pull Request Process

1. Provide a clear **description** of what the PR does and why.
2. Ensure **all CI checks pass** (tests, type-check, lint, build).
3. Request a **code review** from at least one maintainer.
4. Address review feedback promptly.

## Project Structure

```
agentdecode/
├── app/            # Next.js app router pages and layouts
├── lib/            # Shared utilities, clients, and helpers
├── components/     # Reusable React components
├── __tests__/      # Unit and integration tests
├── public/         # Static assets
└── .github/        # CI workflows, PR template, contributing guide
```
