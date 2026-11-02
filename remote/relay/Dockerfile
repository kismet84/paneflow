FROM node:24-bookworm-slim AS relay-build
WORKDIR /build
COPY packages/remote-protocol ./packages/remote-protocol
COPY remote/relay/package*.json ./remote/relay/
WORKDIR /build/remote/relay
RUN npm ci --ignore-scripts && ln -s /build/remote/relay/node_modules /build/node_modules
COPY remote/relay ./
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 BASE_PATH=/
WORKDIR /app
COPY --from=relay-build /build/remote/relay/dist ./dist
COPY --from=relay-build /build/remote/relay/public ./public
COPY --from=relay-build /build/remote/relay/node_modules ./node_modules
COPY --from=relay-build /build/remote/relay/package.json ./package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "const base=(process.env.BASE_PATH||'/').replace(/\/+$/,'');fetch('http://127.0.0.1:3000'+base+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
