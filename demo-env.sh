# Source this: demo environment (separate DB, ports 4100/3100). Safe to re-source.
export MONGODB_URI="mongodb://127.0.0.1:27017/?directConnection=true"
export MONGODB_DB=vso_demo
export PORT=4100
export APP_ORIGIN=http://localhost:3100
export API_ORIGIN=http://localhost:4100
export APP_MODE=local
export ALLOW_DEV_AUTH=true
export NODE_ENV=development
export SALES_FINDER=off
export VSO_API_ORIGIN=http://localhost:4100
