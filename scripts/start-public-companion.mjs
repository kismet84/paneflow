// Stable public entry point. Quick tunnels are intentionally no longer a startup fallback.
import { main } from './public-companion-supervisor.mjs';
await main();
