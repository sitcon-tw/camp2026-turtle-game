# Frontend

React + TypeScript + Vite scaffold, configured with:

- `pnpm`
- Tailwind CSS v4 (`@tailwindcss/vite`)
- ShadCN UI (`components.json` initialized)

## Quick start

```bash
pnpm install
pnpm dev
```

## Current stack

- Framework: Vite
- UI base: shadcn `base` preset
- Alias: `@/`
- Installed helpers:
  - `@base-ui/react`
  - `class-variance-authority`
  - `clsx`
  - `tailwind-merge`
  - `lucide-react`

## Useful commands

- `pnpm run lint`
- `pnpm run build`

ShadCN updates should be done through the CLI:

```bash
pnpm dlx shadcn@latest add <component>
```
