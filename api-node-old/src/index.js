import { ApolloServer } from 'apollo-server-express'
import express, { Router } from 'express'
import bodyParser from 'body-parser'
import cors from 'cors'
import { v1 as neo4j } from 'neo4j-driver'
import http from 'http'
import PhotoScanner from './scanner/Scanner'
import _ from 'lodash'
import config from './config'
import gql from 'graphql-tag'
import path from 'path'

import { getUserFromToken, getTokenFromBearer } from './token'

const app = express()
app.use(bodyParser.json())
app.use(cors())

/*
 * Create a Neo4j driver instance to connect to the database
 * using credentials specified as environment variables
 * with fallback to defaults
 */
const driver = neo4j.driver(
  process.env.NEO4J_URI || 'bolt://localhost:7687',
  neo4j.auth.basic(
    process.env.NEO4J_USER || 'neo4j',
    process.env.NEO4J_PASSWORD || 'letmein'
  )
)

const scanner = new PhotoScanner(driver)

app.use((req, res, next) => {
  req.driver = driver
  req.scanner = scanner

  next()
})

// Every 4th hour
setInterval(scanner.scanAll, 1000 * 60 * 60 * 4)

// Specify port and path for GraphQL endpoint
const graphPath = new URL(path.join(config.host.toString(), '/graphql'))
  .pathname

app.use(graphPath, (req, res, next) => {
  if (req.body.query) {
    const query = gql(req.body.query)
    const defs = query.definitions.filter(x => x.kind == 'OperationDefinition')

    const selections = defs.reduce((prev, curr) => {
      return prev.concat(curr.selectionSet.selections)
    }, [])

    const names = selections.map(x => x.name.value)
    const illegalNames = names.filter(
      name => name.substr(0, 1) == name.substr(0, 1).match(/[A-Z]/)
    )

    if (illegalNames.length > 0) {
      return res
        .status(403)
        .send({ error: `Illegal query, types not allowed: ${illegalNames}` })
    }
  }

  next()
})

const endpointUrl = new URL(config.host)
// endpointUrl.port = process.env.GRAPHQL_LISTEN_PORT || 4001

/*
 * Create a new ApolloServer instance, serving the GraphQL schema
 * created using makeAugmentedSchema above and injecting the Neo4j driver
 * instance into the context object so it is available in the
 * generated resolvers to connect to the database.
 */

import schema from './graphql-schema'

const server = new ApolloServer({
  context: async function({ req }) {
    let user = null
    let token = null

    if (req && req.headers.authorization) {
      token = getTokenFromBearer(req.headers.authorization)
      user = await getUserFromToken(token, driver)
    }

    return {
      ...req,
      driver,
      scanner,
      user,
      token,
      endpoint: endpointUrl.toString(),
    }
  },
  schema,
  introspection: true,
  playground: !process.env.PRODUCTION,
  subscriptions: {
    path: graphPath,
    onConnect: async (connectionParams, webSocket) => {
      const token = getTokenFromBearer(connectionParams.Authorization)
      const user = await getUserFromToken(token, driver)

      return {
        token,
        user,
      }
    },
  },
})

server.applyMiddleware({ app, path: graphPath })
const router = new Router()

import loadImageRoutes from './routes/images'
import loadDownloadRoutes from './routes/downloads'

loadImageRoutes(router)
loadDownloadRoutes(router)

app.use(config.host.pathname, router)

const httpServer = http.createServer(app)
server.installSubscriptionHandlers(httpServer)

httpServer.listen(
  { port: process.env.GRAPHQL_LISTEN_PORT, path: graphPath },
  () => {
    console.log(
      `🚀 GraphQL endpoint ready at ${new URL(server.graphqlPath, endpointUrl)}`
    )

    let subscriptionUrl = new URL(endpointUrl)
    subscriptionUrl.protocol = 'ws'

    console.log(
      `🚀 Subscriptions ready at ${new URL(
        server.subscriptionsPath,
        endpointUrl
      )}`
    )
  }
)