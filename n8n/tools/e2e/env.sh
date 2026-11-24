# Local n8n 2.29.7 for the end-to-end suites (installed in ../n8nrun, see ../README.md). Test values only.
T="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export N8N_USER_FOLDER=$T/n8nrun/home N8N_ENCRYPTION_KEY=sth-test-encryption-key-123456 N8N_DIAGNOSTICS_ENABLED=false N8N_PORT=5799 N8N_HOST=127.0.0.1 N8N_PROTOCOL=http N8N_VERSION_NOTIFICATIONS_ENABLED=false N8N_PERSONALIZATION_ENABLED=false N8N_HIRING_BANNER_ENABLED=false N8N_TEMPLATES_ENABLED=false N8N_RUNNERS_ENABLED=true N8N_BLOCK_ENV_ACCESS_IN_NODE=true NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
export N8N=$T/n8nrun/node_modules/.bin/n8n
export N8N_LISTEN_ADDRESS=0.0.0.0
[ -f /root/.ccr/ca-bundle.crt ] && export NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt
true
