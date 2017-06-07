'use strict'

const {
  GraphQLObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLNonNull,
  GraphQLList
} = require('graphql')
const Oas3Tools = require('./oas_3_tools.js')
const ResolverBuilder = require('./resolver_builder.js')

/**
 * Creates and returns a GraphQL type definition for the given JSON schema.
 * "GraphQL Objects represent a list of named fields, each of which also yields
 * a value of their own type."
 *
 * Nested example: https://gist.github.com/xpepermint/7376b8c67caa926e19d2
 *
 * A returned GraphQLObjectType has the following internal structure:
 *
 * new GraphQLObjectType({
 *   'name'        // optional name of the type
 *   'description' // optional description of type
 *   'fields'      // REQUIRED thunk returning fields
 *     'type'      // REQUIRED definition of the field type
 *     'args'      // optional definition of types
 *     'resolve'   // optional function defining how to obtain this type
 * })
 *
 * @param  {string} name      Name of the Type Definition to create
 * @param  {object} schema    JSON-schema from an OAS schema
 * @param  {object} links     Object containing the (possible) links between
 * this object to other endpoints (= operations)
 * @param  {object} oas       The original OAS
 * @param  {object} allOTs    Object containing operationId as key and derived
 * GraphQLObjectType as value (if existent)
 * @param  {number} iteration Integer count of how many recursions have already
 * been performed in creating this type definition.
 * @return {object}           GraphQLObjectType | GraphQLList |
 * Object with scalar type
 */
const getTypeDef = (name, schema, links, oas, allOTs, iteration) => {
  if (typeof iteration === 'undefined') {
    iteration = 0
  }

  if (iteration === 20) {
    throw new Error(`Too many iterations`)
  }

  // some error checking:
  if (typeof schema !== 'object') {
    throw new Error(`invalid schema provided of type ${typeof schema}`)
  }
  if (typeof schema.type !== 'string') {
    throw new Error(`schema has no/wrong type ${schema.type}`)
  }

  // case: object - create ObjectType:
  if (schema.type === 'object') {
    if (name in allOTs) {
      return allOTs[name]
    } else {
      allOTs[name] = new GraphQLObjectType({
        name: name,
        description: schema.description, // might be undefined
        fields: () => {
          return createFields(schema, links, oas, allOTs, iteration)
        }
      })
      return allOTs[name]
    }
  // case: array - create ArrayType:
  } else if (schema.type === 'array') {
    // let name = path.split('/').pop()
    let name = 'some_name'

    if (!('items' in schema)) {
      throw new Error(`Items property missing in array schema definition`)
    }

    if ('title' in schema.items) {
      name = schema.items.title
    }

    if ('$ref' in schema.items) {
      name = schema.items['$ref'].split('/').pop()
      schema.items = Oas3Tools.resolveRef(schema.items['$ref'], oas)
    }

    if (!('type' in schema.items)) {
      throw new Error(`Type property missing in items definition`)
    }

    if (schema.items.type === 'object' || schema.items.type === 'array') {
      let nextIteration = iteration + 1
      let type
      if (name in allOTs) {
        type = allOTs[name]
      } else {
        type = getTypeDef(name, schema.items, links, oas, allOTs, nextIteration)
      }
      return {
        type: new GraphQLList(type),
        description: schema.description // might be undefined
      }
    } else {
      let type = getScalarType(schema.items.type)
      return {
        type: new GraphQLList(type),
        description: schema.description // might be undefined
      }
    }

  // case: scalar:
  } else {
    return {
      type: getScalarType(schema.type),
      description: schema.description // might be undefined
    }
  }
}

/**
 * Creates the fields object to be used by an ObjectType.
 *
 * @param  {object} schema    JSON-schema from an OAS schema
 * @param  {object} links     Object containing the (possible) links between
 * this object to other endpoints (= operations)
 * @param  {object} oas       The original OAS
 * @param  {object} allOTs    Object containing operationId as key and derived
 * GraphQLObjectType as value (if existent)
 * @param  {number} iteration Integer count of how many recursions have already
 * been performed in creating this type definition.
 * @return {object}           Object of fields for given schema
 */
const createFields = (schema, links, oas, allOTs, iteration) => {
  let fields = {}

  // create fields for all properties:
  for (let propKey in schema.properties) {
    let prop
    if ('$ref' in schema.properties[propKey]) {
      prop = Oas3Tools.resolveRef(schema.properties[propKey]['$ref'], oas)
    } else {
      prop = schema.properties[propKey]
    }

    let nextIteration = iteration + 1
    let otToAdd = getTypeDef(propKey, prop, links, oas, allOTs, nextIteration)
    if (typeof otToAdd.getFields === 'function') {
      fields[propKey] = {
        type: otToAdd
      }
    } else {
      fields[propKey] = otToAdd
    }
  }

  // create fields for (potential) links:
  for (let linkKey in links) {
    // move iteration check outside?
    if (iteration === 0) {
      let operationId
      // TODO: href is yet another alternative to operationRef and operationId
      // if ('operationRef' in links[linkKey]) {
      //   operationId = Oas3Tools.resolveRef(links[linkKey].operationRef, oas).operationId
      // } else if ('operationId' in links[linkKey]) {
      if ('operationId' in links[linkKey]) {
        operationId = links[linkKey].operationId
      } else {
        throw new Error(`operationRef and operationId and hRef properties missing in link definition`)
      }

      let parameters = links[linkKey].parameters

      // create args function:
      // 1. determine parameters provided via link:
      let op = Oas3Tools.getOperationById(operationId, oas)
      let argsFromLink = {}
      for (let linkArg in parameters) {
        argsFromLink[linkArg] = parameters[linkArg].split('body#/')[1]
      }

      // 2. remove argsFromLinks from operation parameters:
      let dynamicParams = op.endpoint.parameters.filter(p => {
        return !(p.name in argsFromLink)
      })

      let linkArgs = getArgs(dynamicParams)

      // create resolve function:
      let linkResolver = ResolverBuilder.getResolver(
        op.path,
        op.method,
        op.endpoint,
        oas,
        argsFromLink
      )

      fields[linkKey] = {
        type: allOTs[operationId],
        resolve: linkResolver,
        args: linkArgs
      }
    }
  }
  return fields
}

/**
 * Helper function that turns given OAS parameters into an object containing
 * GraphQL types.
 *
 * @param  {list} params  List of OAS parameters
 * @return {object}       Object containing as keys parameter names and as
 * values a simple object stating the parameter type.
 */
const getArgs = (params) => {
  let args = {}
  for (let i in params) {
    let param = params[i]
    let type = GraphQLString
    if ('schema' in param &&
      'type' in param.schema &&
      !(param.schema.type === 'object' || param.schema.type === 'array')) {
      type = getScalarType(param.schema.type)
    }
    args[param.name] = {
      type: param.required ? new GraphQLNonNull(type) : type
    }
  }
  return args
}

/**
 * Returns the scalar GraphQL type matching the given JSON schema type.
 *
 * @param  {string} type Scalar JSON schema type
 * @return {string}      Scalar GraphQL type
 */
const getScalarType = (type) => {
  switch (type) {
    case 'string':
      return GraphQLString
    case 'integer':
      return GraphQLInt
    case 'number':
      return GraphQLFloat
    case 'boolean':
      return GraphQLBoolean
    default:
      return null
  }
}

module.exports = {
  getTypeDef,
  getArgs
}
