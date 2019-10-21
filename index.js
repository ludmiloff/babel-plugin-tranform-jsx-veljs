const {default: BabelPluginSyntaxJsx} = require('@babel/plugin-syntax-jsx')
const {default: generator} = require('@babel/generator')

let fragmentId = 0
let rootEl = 0

/**
 * Check if body contains JSX
 * source taken from https://github.com/vuejs/jsx/blob/dev/packages/babel-sugar-inject-h/src/index.js
 * @param {*} t
 * @param {*} path ObjectMethod | ClassMethod
 * @return {boolean}
 */
const hasJSX = (t, path) => {
  const JSXChecker = {
    hasJSX: false,
  }
  path.traverse(
    {
      JSXElement() {
        this.hasJSX = true
      },
    },
    JSXChecker,
  )
  return JSXChecker.hasJSX
}

/**
 * Check if is inside a JSX expression
 * source taken from https://github.com/vuejs/jsx/blob/dev/packages/babel-sugar-inject-h/src/index.js
 * @param {*} t
 * @param {*} path ObjectMethod | ClassMethod
 * @return {boolean}
 */
const isInsideJSXExpression = (t, path) => {
  if (!path.parentPath) {
    return false
  }
  if (t.isJSXExpressionContainer(path.parentPath)) {
    return true
  }
  return isInsideJSXExpression(t, path.parentPath)
}

module.exports = api => {

  api.assertVersion(7)
  const t = api.types

  return {
    inherits: BabelPluginSyntaxJsx,
    visitor: {
      // inject `const self = this` into every VirtualElement method containing JSX
      Program(path) {
        path.traverse({
          'ObjectMethod|ClassMethod'(path) {
            if (!hasJSX(t, path) || isInsideJSXExpression(t, path)) {
              return
            }

            path
              .get('body')
              .unshiftContainer(
                'body',
                t.variableDeclaration('const', [
                  t.variableDeclarator(
                    t.identifier('self'),
                    t.thisExpression()
                  ),
                ]),
              )
          },
        })
      },

      JSXElement(path) {
        rootEl += 1
        fragmentId += 1
        const virt  = isVirtualElement(path.node.openingElement.name)
        if (virt && rootEl == 1) {
          path.replaceWith(renderElement(path.node)[0])
        } 
        else {
          path.replaceWith(transformElement(renderElement(path.node), fragmentId))
        }
        rootEl -= 1
      },

      JSXFragment(path) {
        fragmentId += 1
        path.replaceWith(transformElement(renderElement(path.node), fragmentId))
      },
    },
  }

  /**
   * take array of quasis (strings) + expressions (AST nodes) and produce TemplateLiteral node
   * @param {Array<*>} parts
   * @param {Number} fragment - jsx fragment number
   * @param {Boolean} tagged - return tagged template expression or template literal
   * @return {object}
   **/
  function transformElement(parts, fragment, tagged = true) {

    // we have one mixed array and we need to split nodes by type
    const quasis = [], exprs = []

    let i = 0

    // do one iteration more to make sure we produce an empty string quasi at the end
    while (i < parts.length + 1) {

      let quasi = ''
      // join adjacent strings into one
      while (typeof parts[i] == 'string') {
        // we need to escape backticks and backslashes manually
        quasi += parts[i].replace(/[\\`]/g, s => `\\${s}`)
        i += 1
      }

      quasis.push(t.templateElement({raw: quasi, cooked: quasi}))

      // add a single expr node
      if (parts[i] != null) {
        exprs.push(parts[i])
      }

      i += 1 // repeat

    }

    const ret = tagged
      ? t.taggedTemplateExpression(
        t.identifier('this.part(' + fragment + ')'),
        t.templateLiteral(quasis, exprs)
      )
      : t.templateLiteral(quasis, exprs)

    return ret
  }

  /**
   * take JSXElement and return array of template strings and parts
   * @param {*} elem
   * @return {Array<*>}
   */
  function renderElement(elem) {
    if (elem.type == 'JSXFragment') {
      const children = elem.children.map(renderChild)
      return [...flatten(children)]
    }

    if (elem.type == 'JSXElement') {
      const {tag, isVoid, isClass, className} = renderTag(elem.openingElement.name)
      const children = elem.children.map(renderChild)

      if (isClass) {
        return renderClassElement(elem, className)
      }

      const attrs = elem.openingElement.attributes.map(renderProp)
      return [
        '<', tag, ...flatten(attrs), '>',
        ...isVoid ? [] : flatten(children),
        ...isVoid ? [] : ['</', tag, '>'],
      ]
    }
    throw new Error(`Unknown element type: ${elem.type}`)
  }

  /**
   * take VirtualElement as JSXElement and return array of template strings and parts
   * @param {*} elem
   * @param {*} className
   * @return {Array<*>}
   */  
  function renderClassElement(elem, className) {
    const classAttrs = elem.openingElement.attributes.map(renderClassProp)
    fragmentId += 1

    let hasKeyAttr = false
    let keyValue
    for (let i = 0; i < classAttrs.length; i++) {
      if (classAttrs[i][0].key.name === 'key') {
        keyValue = classAttrs[i][0].value
        hasKeyAttr = true
        break
      }
    }

    const keyParam = hasKeyAttr ? keyValue : t.identifier(`"_f${fragmentId}_"`) // fragmentId
    return [
      t.callExpression(
        t.memberExpression(className, t.identifier('for')), [
          t.identifier('self'),
          keyParam,
          t.objectExpression(flatten(classAttrs)),
        ]),
    ]    
  }

  /**
   * Check if name is a HTML tag or VirtualElement tag
   * @param {*} name
   * @return {boolean}
   */
  function isVirtualElement(name) {
    // name is an identifier
    if (name.type == 'JSXIdentifier') {

      // it's a single lowercase identifier (e.g. `foo`)
      if (t.react.isCompatTag(name.name)) {
        // html element
        return false
      }

      // must be a virtual element
      return true
    }
  }

  /**
   * Take JSXElement name (Identifier or MemberExpression) and return JS counterpart
   * @param {*} name
   * @param {boolean} root Whether it's the root of expression tree
   * @return {{tag: *, isVoid: boolean}}
   */
  function renderTag(name, root = true) {

    // name is an identifier
    if (name.type == 'JSXIdentifier') {

      const tag = name.name

      // it's a single lowercase identifier (e.g. `foo`)
      if (root && t.react.isCompatTag(tag)) {
        const isVoid = voidElements.includes(tag.toLowerCase())
        // return it as part of the template (`<foo>`)
        return {tag, isVoid}
      }

      // it's a single uppercase identifier (e.g. `Foo`)
      else if (root) {
        const object = t.identifier(tag)
        // must transformed into Foo.for()
        return {tag, isClass: true, className: object}
      }

      // it's not the only identifier, it's a part of a member expression
      // return it as identifier
      else return {tag: t.identifier(tag)}

    }

    // tag names can also be member expressions (`Foo.Bar`)
    if (name.type == 'JSXMemberExpression') {
      const expr = name // transform recursively
      const {tag: object} = renderTag(expr.object, false)
      const property = t.identifier(expr.property.name)
      const tag = root // stick `.is` to the root member expr
        ? t.memberExpression(t.memberExpression(object, property), t.identifier('is'))
        : t.memberExpression(object, property)
      return {tag} // return as member expr
    }

    throw new Error(`Unknown element tag type: ${name.type}`)

  }

  /**
   * Take JSXAttribute and return array of template strings and parts
   * @param {*} prop
   * @return {Array<*>}
   */
  function renderProp(prop) {

    const [jsxName, eventName, attributeName]
      = prop.name.name.match(/^(?:on-?(.*)|(.*))$/)

    if (prop.value) { // prop has a value

      if (prop.value.type == 'StringLiteral') { // value is a string literal

        // we are setting an attribute with value, produce template strings
        if (attributeName) {
          let name
          // transforming React style className into class
          if (attributeName == 'className') {
            name = 'class'
          }
          else {
            name = attributeName
          }
          return [' ', `${name}`, '=', prop.value.extra.raw]
        }

        // setting event handler to a string doesn't make sense
        if (eventName) throw Error(`Event prop can't be a string literal`)

      }
      if (prop.value.type == 'JSXExpressionContainer') { // value is an expression

        // modify the name and produce a template expression in all cases
        if (attributeName) return [' ', `${attributeName}`, '=', prop.value.expression]
        if (eventName) return [' ', `on${eventName.toLowerCase()}`, '=', prop.value.expression]

      }
    }
    else { // prop has no value

      // we are setting a boolean attribute
      if (attributeName) return [' ', `${attributeName}`]

      // valueless event handler doesn't make sense
      if (eventName) throw Error(`Event prop must have a value`)
    }
    throw new Error(`Couldn't transform attribute ${JSON.stringify(jsxName)}`)
  }

  /**
   * Take JSXAttribute and return VirtualElement call property
   * @param {*} prop
   * @return {Array<*>}
   */
  function renderClassProp(prop) {

    const [jsxName, eventName, attributeName] = prop.name.name.match(/^(?:on-?(.*)|(.*))$/)

    if (prop.value) { // prop has a value

      if (prop.value.type == 'StringLiteral') { // value is a string literal

        // we are setting an attribute, produce template strings
        if (attributeName) {
          return [t.objectProperty(t.identifier(attributeName), prop.value)]
        }

        // setting event handler to a string doesn't make sense
        if (eventName) throw Error(`Event prop can't be a string literal`)
      }

      if (prop.value.type == 'JSXExpressionContainer') { // value is an expression
        // modify the name and produce a template expression in all cases
        if (attributeName) {
          if (prop.value.expression.type == 'JSXElement') {
            // value is jsx element, produce another partial result and pass it
            // TODO: check prop value expression
            const templateValue = transformElement(renderElement(prop.value.expression), fragmentId, false)
            if (isVirtualElement(prop.value.expression)) {
              return [t.objectProperty(t.identifier(attributeName), `${generator(templateValue).code}`)]
            } 
            else {
              fragmentId += 1
              return [
                t.objectProperty(
                  t.identifier(attributeName), 
                  prop.value.expression, // `this.part(${fragmentId})${generator(templateValue).code}`
                ),
              ]
            }
          }

          return [t.objectProperty(t.identifier(attributeName), prop.value.expression)]
        }
        if (eventName) {
          return [t.objectProperty(t.identifier(`on${eventName}`), prop.value.expression)]
        }
      }
    }
    else { // prop has no value

      // Valueless property default to `true` (imitate React)
      if (attributeName) {
        return [t.objectProperty(t.identifier(attributeName), t.booleanLiteral(true))]
      }

      // valueless event handler doesn't make sense
      if (eventName) throw Error(`Event prop must have a value`)
    }

    throw new Error(`Couldn't transform attribute ${JSON.stringify(jsxName)}`)
  }

  /**
   * Take JSX child node and return array of template strings and parts
   * @param {*} child
   * @return {Array<*>}
   */
  function renderChild(child) {

    if (child.type == 'JSXText') return [child.extra.raw] // text becomes part of template

    if (child.type == 'JSXExpressionContainer') {
      if (child.expression.type == 'JSXEmptyExpression') return []
      else return [child.expression] // expression renders as part
    }

    if (child.type == 'JSXElement' || child.type == 'JSXFragment')
      return renderElement(child) // recurse on element

    throw new Error(`Unknown child type: ${child.type}`)
  }

}

const flatten = arrs => arrs.reduce((xs, x) => [...xs, ...x], [])

const voidElements = [
  'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'command',
  'embed', 'frame', 'hr', 'image', 'img', 'input', 'isindex', 'keygen',
  'link', 'menuitem', 'meta', 'nextid', 'param', 'source', 'track', 'wbr',
]
