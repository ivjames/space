# Space

A launch-and-upgrade space program game for mobile. Launch autonomous rockets, earn funds, buy your way up a tech tree, reach further out.

## Run locally

```bash
npm test          # Run tests
npm run serve     # Start dev server, then open http://localhost:8080
```

## Architecture

The game runs as a single-page web app with vanilla JavaScript, HTML5 canvas, and no build step for the web. See [ARCHITECTURE.md](ARCHITECTURE.md) for the module structure and [DESIGN.md](DESIGN.md) for design decisions and mechanics.

The codebase is structured to work as both a PWA and a Capacitor app for mobile stores.

## TODO

- PNG icons for iOS (currently SVG only)
- Capacitor wrap and native store builds
