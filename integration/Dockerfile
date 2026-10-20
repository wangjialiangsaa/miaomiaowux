FROM node:24-alpine
WORKDIR /app
COPY integration/*.mjs ./integration/
COPY ui/nodectl ./ui/nodectl
ENV HOST=0.0.0.0 PORT=12900
USER node
EXPOSE 12900
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:12900/_nodectl/health').then(response=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "integration/main.mjs"]
