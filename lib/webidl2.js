"use strict";

(() => {
  // These regular expressions use the sticky flag so they will only match at
  // the current location (ie. the offset of lastIndex).
  const tokenRe = {
    // This expression uses a lookahead assertion to catch false matches
    // against integers early.
    "float": /-?(?=[0-9]*\.|[0-9]+[eE])(([0-9]+\.[0-9]*|[0-9]*\.[0-9]+)([Ee][-+]?[0-9]+)?|[0-9]+[Ee][-+]?[0-9]+)/y,
    "integer": /-?(0([Xx][0-9A-Fa-f]+|[0-7]*)|[1-9][0-9]*)/y,
    "identifier": /_?[A-Za-z][0-9A-Z_a-z-]*/y,
    "string": /"[^"]*"/y,
    "whitespace": /[\t\n\r ]+/y,
    "comment": /((\/(\/.*|\*([^*]|\*[^/])*\*\/)[\t\n\r ]*)+)/y,
    "other": /[^\t\n\r 0-9A-Za-z]/y
  };

  const stringTypes = [
    "ByteString",
    "DOMString",
    "USVString"
  ];

  const argumentNameKeywords = [
    "attribute",
    "callback",
    "const",
    "deleter",
    "dictionary",
    "enum",
    "getter",
    "includes",
    "inherit",
    "interface",
    "iterable",
    "maplike",
    "namespace",
    "partial",
    "required",
    "setlike",
    "setter",
    "static",
    "stringifier",
    "typedef",
    "unrestricted"
  ];

  const nonRegexTerminals = [
    "FrozenArray",
    "Infinity",
    "NaN",
    "Promise",
    "boolean",
    "byte",
    "double",
    "false",
    "float",
    "implements",
    "legacyiterable",
    "long",
    "mixin",
    "null",
    "octet",
    "optional",
    "or",
    "readonly",
    "record",
    "sequence",
    "short",
    "true",
    "unsigned",
    "void"
  ].concat(argumentNameKeywords, stringTypes);

  const punctuations = [
    "(",
    ")",
    ",",
    "-Infinity",
    "...",
    ":",
    ";",
    "<",
    "=",
    ">",
    "?",
    "[",
    "]",
    "{",
    "}"
  ];

  function tokenise(str) {
    const tokens = [];
    let lastIndex = 0;
    let trivia = "";
    while (lastIndex < str.length) {
      const nextChar = str.charAt(lastIndex);
      let result = -1;

      if (/[\t\n\r ]/.test(nextChar)) {
        result = attemptTokenMatch("whitespace", { noFlushTrivia: true });
      } else if (nextChar === '/') {
        result = attemptTokenMatch("comment", { noFlushTrivia: true });
      }

      if (result !== -1) {
        trivia += tokens.pop().value;
      } else if (/[-0-9.]/.test(nextChar)) {
        result = attemptTokenMatch("float");
        if (result === -1) {
          result = attemptTokenMatch("integer");
        }
      } else if (/[A-Z_a-z]/.test(nextChar)) {
        result = attemptTokenMatch("identifier");
        const token = tokens[tokens.length - 1];
        if (result !== -1 && nonRegexTerminals.includes(token.value)) {
          token.type = token.value;
        }
      } else if (nextChar === '"') {
        result = attemptTokenMatch("string");
      }

      for (const punctuation of punctuations) {
        if (str.startsWith(punctuation, lastIndex)) {
          tokens.push({ type: punctuation, value: punctuation, trivia });
          trivia = "";
          lastIndex += punctuation.length;
          result = lastIndex;
          break;
        }
      }

      // other as the last try
      if (result === -1) {
        result = attemptTokenMatch("other");
      }
      if (result === -1) {
        throw new Error("Token stream not progressing");
      }
      lastIndex = result;
    }

    // remaining trivia as eof
    tokens.push({
      type: "eof",
      trivia
    });

    return tokens;

    function attemptTokenMatch(type, { noFlushTrivia } = {}) {
      const re = tokenRe[type];
      re.lastIndex = lastIndex;
      const result = re.exec(str);
      if (result) {
        tokens.push({ type, value: result[0], trivia });
        if (!noFlushTrivia) {
          trivia = "";
        }
        return re.lastIndex;
      }
      return -1;
    }
  }

  class WebIDLParseError {
    constructor(str, line, input, tokens) {
      this.message = str;
      this.line = line;
      this.input = input;
      this.tokens = tokens;
    }

    toString() {
      const escapedInput = JSON.stringify(this.input);
      const tokens = JSON.stringify(this.tokens, null, 4);
      return `${this.message}, line ${this.line} (tokens: ${escapedInput})\n${tokens}`;
    }
  }

  function parse(tokens) {
    let line = 1;
    tokens = tokens.slice();
    const names = new Map();
    let current = null;

    const FLOAT = "float";
    const INT = "integer";
    const ID = "identifier";
    const STR = "string";

    const EMPTY_OPERATION = Object.freeze({
      type: "operation",
      getter: null,
      setter: null,
      deleter: null,
      static: null,
      stringifier: null,
      body: null
    });

    const EMPTY_IDLTYPE = Object.freeze({
      generic: null,
      nullable: null,
      union: false,
      idlType: null,
      baseName: null,
      prefix: null,
      postfix: null,
      separator: null,
      extAttrs: null
    });

    function error(str) {
      const maxTokens = 5;
      const tok = tokens
        .slice(consume_position, consume_position + maxTokens)
        .map(t => t.trivia + t.value).join("");
      // Count newlines preceding the actual erroneous token
      if (tokens[consume_position] && !probe("eof")) {
        line += count(tokens[consume_position].trivia, "\n");
      }

      let message;
      if (current) {
        message = `Got an error during or right after parsing \`${current.partial ? "partial " : ""}${current.type} ${current.name}\`: ${str}`;
      }
      else {
        // throwing before any valid definition
        message = `Got an error before parsing any named definition: ${str}`;
      }

      throw new WebIDLParseError(message, line, tok, tokens.slice(0, maxTokens));
    }

    function sanitize_name(name, type) {
      const unescaped = unescape(name);
      if (names.has(unescaped)) {
        error(`The name "${unescaped}" of type "${names.get(unescaped)}" was already seen`);
      }
      names.set(unescaped, type);
      return unescaped;
    }

    let consume_position = 0;

    function probe(type) {
      return tokens.length > consume_position && tokens[consume_position].type === type;
    }

    function consume(...candidates) {
      // TODO: use const when Servo updates its JS engine
      // eslint-disable-next-line prefer-const
      for (let type of candidates) {
        if (!probe(type)) continue;
        const token = tokens[consume_position];
        consume_position++;
        line += count(token.trivia, "\n");
        return token;
      }
    }

    /** Use when the target token is intended to be exposed via API */
    function untyped_consume(...args) {
      const token = consume(...args);
      if (token) {
        const { value, trivia } = token;
        return { value, trivia };
      }
    }

    function unescape(identifier) {
      return identifier.startsWith('_') ? identifier.slice(1) : identifier;
    }

    function unconsume(position) {
      while (consume_position > position) {
        consume_position--;
        line -= count(tokens[consume_position].trivia, "\n");
      }
    }

    function count(str, char) {
      let total = 0;
      for (let i = str.indexOf(char); i !== -1; i = str.indexOf(char, i + 1)) {
        ++total;
      }
      return total;
    }

    function integer_type() {
      const prefix = untyped_consume("unsigned") || null;
      const base = untyped_consume("short", "long");
      if (base) {
        const postfix = untyped_consume("long") || null;
        return {
          idlType: [prefix, base, postfix].filter(t => t).map(t => t.value).join(' '),
          prefix,
          postfix,
          baseName: base.value,
          trivia: { base: base.trivia }
        };
      }
      if (prefix) error("Failed to parse integer type");
    }

    function float_type() {
      const prefix = untyped_consume("unrestricted") || null;
      const base = untyped_consume("float", "double");
      if (base) {
        return {
          idlType: [prefix, base].filter(t => t).map(t => t.value).join(' '),
          prefix,
          baseName: base.value,
          trivia: { base: base.trivia }
        };
      }
      if (prefix) error("Failed to parse float type");
    }

    function primitive_type() {
      const num_type = integer_type() || float_type();
      if (num_type) return num_type;
      const base = consume("boolean", "byte", "octet");
      if (base) {
        return {
          idlType: base.value,
          baseName: base.value,
          trivia: { base: base.trivia }
        };
      }
    }

    function const_value() {
      const token = consume("true", "false", "null", "Infinity", "-Infinity", "NaN", FLOAT, INT);
      if (!token) {
        return;
      }
      const { trivia } = token;
      let data;
      switch (token.type) {
        case "true":
        case "false":
          data = { type: "boolean", value: token.type === "true" };
          break;
        case "Infinity":
        case "-Infinity":
          data = { type: "Infinity", negative: token.type.startsWith("-") };
          break;
        case FLOAT:
        case INT:
          data = { type: "number", value: token.value };
          break;
        default:
          data = { type: token.type };
      }
      return { data, trivia };
    }

    function type_suffix(obj) {
      const nullable = consume("?");
      if (nullable) {
        obj.nullable = { trivia: nullable.trivia };
      }
      if (probe("?")) error("Can't nullable more than once");
    }

    function generic_type(typeName) {
      const name = consume("FrozenArray", "Promise", "sequence", "record");
      if (!name) {
        return;
      }
      const ret = {
        baseName: name.value,
        generic: { value: name.value, trivia: {} },
        trivia: { base: name.trivia }
      };
      const open = consume("<") || error(`No opening bracket after ${name.type}`);
      ret.generic.trivia.open = open.trivia;
      switch (name.type) {
        case "Promise":
          if (probe("[")) error("Promise type cannot have extended attribute");
          ret.idlType = [return_type(typeName)];
          break;
        case "sequence":
        case "FrozenArray":
          ret.idlType = [type_with_extended_attributes(typeName)];
          break;
        case "record": {
          if (probe("[")) error("Record key cannot have extended attribute");
          ret.idlType = [];
          const keyType = consume(...stringTypes);
          if (!keyType) error(`Record key must be a string type`);
          const separator = untyped_consume(",") || error("Missing comma after record key type");
          ret.idlType.push(Object.assign({ type: typeName }, EMPTY_IDLTYPE, {
            baseName: keyType.value,
            idlType: keyType.value,
            separator,
            trivia: {
              base: keyType.trivia
            }
          }));
          const valueType = type_with_extended_attributes(typeName) || error("Error parsing generic type record");
          ret.idlType.push(valueType);
          break;
        }
      }
      if (!ret.idlType) error(`Error parsing generic type ${name.type}`);
      const close = consume(">") || error(`Missing closing bracket after ${name.type}`);
      ret.generic.trivia.close = close.trivia;
      return ret;
    }

    function single_type(typeName) {
      const ret = Object.assign({ type: typeName || null }, EMPTY_IDLTYPE, { trivia: {} });
      const base = generic_type(typeName) || primitive_type();
      if (base) {
        Object.assign(ret, base);
      } else {
        const name = consume(ID, ...stringTypes);
        if (!name) {
          return;
        }
        ret.baseName = ret.idlType = name.value;
        ret.trivia.base = name.trivia;
        if (probe("<")) error(`Unsupported generic type ${name.value}`);
      }
      if (ret.generic && ret.generic.value === "Promise" && probe("?")) {
        error("Promise type cannot be nullable");
      }
      type_suffix(ret);
      if (ret.nullable && ret.idlType === "any") error("Type any cannot be made nullable");
      return ret;
    }

    function union_type(typeName) {
      const open = consume("(");
      if (!open) return;
      const trivia = { open: open.trivia };
      const ret = Object.assign({ type: typeName || null }, EMPTY_IDLTYPE, { union: true, idlType: [], trivia });
      while (true) {
        const typ = type_with_extended_attributes() || error("No type after open parenthesis or 'or' in union type");
        ret.idlType.push(typ);
        const or = untyped_consume("or");
        if (or) {
          typ.separator = or;
        }
        else break;
      }
      if (ret.idlType.length < 2) {
        error("At least two types are expected in a union type but found less");
      }
      const close = consume(")") || error("Unterminated union type");
      trivia.close = close.trivia;
      type_suffix(ret);
      return ret;
    }

    function type(typeName) {
      return single_type(typeName) || union_type(typeName);
    }

    function type_with_extended_attributes(typeName) {
      const extAttrs = extended_attrs();
      const ret = single_type(typeName) || union_type(typeName);
      if (ret) ret.extAttrs = extAttrs;
      return ret;
    }

    function argument() {
      const start_position = consume_position;
      const ret = { optional: null, variadic: null, default: null, trivia: {} };
      ret.extAttrs = extended_attrs();
      const optional = consume("optional");
      if (optional) {
        ret.optional = { trivia: optional.trivia };
      }
      ret.idlType = type_with_extended_attributes("argument-type");
      if (!ret.idlType) {
        unconsume(start_position);
        return;
      }
      if (!ret.optional) {
        const variadic = consume("...");
        if (variadic) {
          ret.variadic = { trivia: variadic.trivia };
        }
      }
      const name = consume(ID, ...argumentNameKeywords);
      if (!name) {
        unconsume(start_position);
        return;
      }
      ret.name = unescape(name.value);
      ret.escapedName = name.value;
      ret.trivia.name = name.trivia;
      if (ret.optional) {
        ret.default = default_() || null;
      }
      return ret;
    }

    function argument_list() {
      const ret = [];
      const arg = argument();
      if (!arg) return ret;
      arg.separator = untyped_consume(",") || null;
      ret.push(arg);
      while (arg.separator) {
        const nxt = argument() || error("Trailing comma in arguments list");
        nxt.separator = untyped_consume(",") || null;
        ret.push(nxt);
        if (!nxt.separator) break;
      }
      return ret;
    }

    function simple_extended_attr() {
      const name = consume(ID);
      if (!name) return;
      const trivia = { name: name.trivia };
      const ret = {
        name: name.value,
        signature: null,
        type: "extended-attribute",
        rhs: null,
        trivia
      };
      const eq = consume("=");
      if (eq) {
        ret.rhs = consume(ID, FLOAT, INT, STR);
        if (ret.rhs) {
          ret.rhs.trivia = {
            assign: eq.trivia,
            value: ret.rhs.trivia
          };
        }
      }
      const open = consume("(");
      if (open) {
        const listTrivia = { open: open.trivia };
        if (eq && !ret.rhs) {
          // [Exposed=(Window,Worker)]
          listTrivia.assign = eq.trivia;
          ret.rhs = {
            type: "identifier-list",
            value: identifiers(),
            trivia: listTrivia
          };
        }
        else {
          // [NamedConstructor=Audio(DOMString src)] or [Constructor(DOMString str)]
          ret.signature = {
            arguments: argument_list(),
            trivia: listTrivia
          };
        }
        const close = consume(")") || error("Unexpected token in extended attribute argument list");
        listTrivia.close = close.trivia;
      }
      if (eq && !ret.rhs) error("No right hand side to extended attribute assignment");
      return ret;
    }

    // Note: we parse something simpler than the official syntax. It's all that ever
    // seems to be used
    function extended_attrs() {
      const open = consume("[");
      if (!open) return null;
      const eas = {
        trivia: { open: open.trivia },
        items: []
      };
      const first = simple_extended_attr() || error("Extended attribute with not content");
      first.separator = untyped_consume(",") || null;
      eas.items.push(first);
      while (first.separator) {
        const attr = simple_extended_attr() || error("Trailing comma in extended attribute");
        attr.separator = untyped_consume(",") || null;
        eas.items.push(attr);
        if (!attr.separator) break;
      }
      const close = consume("]") || error("No end of extended attribute");
      eas.trivia.close = close.trivia;
      return eas;
    }

    function default_() {
      const assign = consume("=");
      if (!assign) {
        return;
      }

      const trivia = { assign: assign.trivia };
      const def = const_value();
      if (def) {
        trivia.value = def.trivia;
        return Object.assign(def.data, { trivia });
      }

      const open = consume("[");
      if (open) {
        const close = consume("]");
        if (!close) error("Default sequence value must be empty");
        trivia.open = open.trivia;
        trivia.close = close.trivia;
        return { type: "sequence", value: [], trivia };
      }

      const str = consume(STR) || error("No value for default");
      str.value = str.value.slice(1, -1);
      trivia.value = str.trivia;
      str.trivia = trivia;
      return str;
    }

    function const_() {
      const base = consume("const");
      if (!base) return;
      const trivia = { base: base.trivia };
      const ret = { type: "const" };
      let typ = primitive_type();
      if (!typ) {
        typ = consume(ID) || error("No type for const");
        typ = { idlType: typ.value, baseName: typ.value, trivia: { base: typ.trivia } };
      }
      ret.idlType = Object.assign({ type: "const-type" }, EMPTY_IDLTYPE, typ);
      type_suffix(ret.idlType);
      const name = consume(ID) || error("No name for const");
      ret.name = name.value;
      trivia.name = name.trivia;
      const assign = consume("=") || error("No value assignment for const");
      trivia.assign = assign.trivia;
      const cnt = const_value() || error("No value for const");
      ret.value = cnt.data;
      trivia.value = cnt.trivia;
      const termination = consume(";") || error("Unterminated const");
      trivia.termination = termination.trivia;
      ret.trivia = trivia;
      return ret;
    }

    function inheritance() {
      const colon = consume(":");
      if (colon) {
        const inh = consume(ID) || error("No type in inheritance");
        return { name: inh.value, trivia: { colon: colon.trivia, name: inh.trivia } };
      }
    }

    function operation_rest(ret) {
      const { body } = ret;
      body.trivia = {};
      const name = consume(ID);
      body.name = name ? {
        value: unescape(name.value),
        escaped: name.value,
        trivia: name.trivia,
      } : null;
      const open = consume("(") || error("Invalid operation");
      body.trivia.open = open.trivia;
      body.arguments = argument_list();
      const close = consume(")") || error("Unterminated operation");
      body.trivia.close = close.trivia;
      const termination = consume(";") || error("Unterminated operation");
      ret.trivia = { termination: termination.trivia };
      return ret;
    }

    function callback() {
      let ret;
      const callbackToken = consume("callback");
      if (!callbackToken) return;
      const tok = consume("interface");
      if (tok) {
        ret = interface_rest({ typeName: "callback interface" });
        ret.trivia.callback = callbackToken.trivia;
        ret.trivia.base = tok.trivia;
        return ret;
      }
      const trivia = { base: callbackToken.trivia };
      const name = consume(ID) || error("No name for callback");
      trivia.name = name.trivia;
      ret = current = { type: "callback", name: sanitize_name(name.value, "callback") };
      const assign = consume("=") || error("No assignment in callback");
      trivia.assign = assign.trivia;
      ret.idlType = return_type() || error("Missing return type");
      const open = consume("(") || error("No arguments in callback");
      trivia.open = open.trivia;
      ret.arguments = argument_list();
      const close = consume(")") || error("Unterminated callback");
      trivia.close = close.trivia;
      const termination = consume(";") || error("Unterminated callback");
      trivia.termination = termination.trivia;
      ret.trivia = trivia;
      return ret;
    }

    function attribute({ noInherit = false, readonly = false } = {}) {
      const start_position = consume_position;
      const ret = {
        type: "attribute",
        static: null,
        stringifier: null,
        inherit: null,
        readonly: null,
        trivia: {}
      };
      if (!noInherit) {
        const inherit = consume("inherit");
        if (inherit) {
          ret.inherit = { trivia: inherit.trivia };
        }
      }
      const readonlyToken = consume("readonly");
      if (readonlyToken) {
        ret.readonly = { trivia: readonlyToken.trivia };
      } else if (readonly && probe("attribute")) {
        error("Attributes must be readonly in this context");
      }
      const rest = attribute_rest(ret);
      if (!rest) {
        unconsume(start_position);
      }
      return rest;
    }

    function attribute_rest(ret) {
      const base = consume("attribute");
      if (!base) {
        return;
      }
      ret.trivia.base = base.trivia;
      ret.idlType = type_with_extended_attributes("attribute-type") || error("No type in attribute");
      switch (ret.idlType.generic && ret.idlType.generic.value) {
        case "sequence":
        case "record": error(`Attributes cannot accept ${ret.idlType.generic.value} types`);
      }
      const name = consume(ID, "required") || error("No name in attribute");
      ret.name = unescape(name.value);
      ret.escapedName = name.value;
      ret.trivia.name = name.trivia;
      const termination = consume(";") || error("Unterminated attribute");
      ret.trivia.termination = termination.trivia;
      return ret;
    }

    function return_type(typeName) {
      const typ = type(typeName || "return-type");
      if (typ) {
        return typ;
      }
      const voidToken = consume("void");
      if (voidToken) {
        return Object.assign({ type: "return-type" }, EMPTY_IDLTYPE, {
          idlType: "void",
          baseName: "void",
          trivia: { base: voidToken.trivia }
        });
      }
    }

    function operation({ regular = false } = {}) {
      const ret = Object.assign({}, EMPTY_OPERATION, { body: {} });
      if (!regular) {
        const special = consume("getter", "setter", "deleter");
        if (special) {
          ret[special.type] = { trivia: special.trivia };
        }
      }
      ret.body.idlType = return_type() || error("Missing return type");
      operation_rest(ret);
      return ret;
    }

    function static_member() {
      const token = consume("static");
      if (!token) return;
      const member = attribute({ noInherit: true }) ||
        operation({ regular: true }) ||
        error("No body in static member");
      member.static = { trivia: token.trivia };
      return member;
    }

    function stringifier() {
      const token = consume("stringifier");
      if (!token) return;
      const triviaObject = { trivia: token.trivia };
      const termination = consume(";");
      if (termination) {
        return Object.assign({}, EMPTY_OPERATION, {
          stringifier: triviaObject,
          trivia: {
            termination: termination.trivia
          }
        });
      }
      const member = attribute({ noInherit: true }) ||
        operation({ regular: true }) ||
        error("Unterminated stringifier");
      member.stringifier = triviaObject;
      return member;
    }

    function identifiers() {
      const arr = [];
      const id = untyped_consume(ID) || error("Expected identifiers but none found");
      id.separator = untyped_consume(",") || null;
      arr.push(id);
      while (id.separator) {
        const id = untyped_consume(ID) || error("Trailing comma in identifiers list");
        id.separator = untyped_consume(",") || null;
        arr.push(id);
        if (!id.separator) break;
      }
      return arr;
    }

    function iterable_type() {
      return consume("iterable", "maplike", "setlike");
    }

    function readonly_iterable_type() {
      return consume("maplike", "setlike");
    }

    function iterable() {
      const start_position = consume_position;
      const ret = { type: null, idlType: null, readonly: null, trivia: {} };
      const readonly = consume("readonly");
      if (readonly) {
        ret.readonly = { trivia: readonly.trivia };
      }
      const consumeItType = ret.readonly ? readonly_iterable_type : iterable_type;

      const ittype = consumeItType();
      if (!ittype) {
        unconsume(start_position);
        return;
      }
      ret.trivia.base = ittype.trivia;

      const secondTypeRequired = ittype.value === "maplike";
      const secondTypeAllowed = secondTypeRequired || ittype.value === "iterable";
      ret.type = ittype.value;
      if (ret.type !== 'maplike' && ret.type !== 'setlike')
        delete ret.readonly;
      const open = consume("<") || error(`Error parsing ${ittype.value} declaration`);
      ret.trivia.open = open.trivia;
      const first = type_with_extended_attributes() || error(`Error parsing ${ittype.value} declaration`);
      ret.idlType = [first];
      if (secondTypeAllowed) {
        first.separator = untyped_consume(",") || null;
        if (first.separator) {
          ret.idlType.push(type_with_extended_attributes());
        }
        else if (secondTypeRequired)
          error(`Missing second type argument in ${ittype.value} declaration`);
      }
      const close = consume(">") || error(`Unterminated ${ittype.value} declaration`);
      ret.trivia.close = close.trivia;
      const termination = consume(";") || error(`Missing semicolon after ${ittype.value} declaration`);
      ret.trivia.termination = termination.trivia;

      return ret;
    }

    function interface_rest({ typeName = "interface", partialModifier = null } = {}) {
      const name = consume(ID) || error("No name for interface");
      const trivia = {
        base: null,
        name: name.trivia
      };
      const mems = [];
      const ret = current = {
        type: typeName,
        name: partialModifier ? name.value : sanitize_name(name.value, "interface"),
        escapedName: name.value,
        partial: partialModifier,
        members: mems,
        trivia
      };
      if (!partialModifier) ret.inheritance = inheritance() || null;
      const open = consume("{") || error("Bodyless interface");
      trivia.open = open.trivia;
      while (true) {
        const close = consume("}");
        if (close) {
          trivia.close = close.trivia;
          const termination = consume(";") || error("Missing semicolon after interface");
          trivia.termination = termination.trivia;
          return ret;
        }
        const ea = extended_attrs();
        const mem = const_() ||
          static_member() ||
          stringifier() ||
          iterable() ||
          attribute() ||
          operation() ||
          error("Unknown member");
        mem.extAttrs = ea;
        ret.members.push(mem);
      }
    }

    function mixin_rest({ partialModifier = null } = {}) {
      const mixin = consume("mixin");
      if (!mixin) return;
      const trivia = {
        base: null,
        mixin: mixin.trivia
      };
      const name = consume(ID) || error("No name for interface mixin");
      trivia.name = name.trivia;
      const mems = [];
      const ret = current = {
        type: "interface mixin",
        name: partialModifier ? name.value : sanitize_name(name.value, "interface mixin"),
        escapedName: name.value,
        partial: partialModifier,
        members: mems,
        trivia
      };
      const open = consume("{") || error("Bodyless interface mixin");
      trivia.open = open.trivia;
      while (true) {
        const close = consume("}");
        if (close) {
          trivia.close = close.trivia;
          const termination = consume(";") || error("Missing semicolon after interface mixin");
          trivia.termination = termination.trivia;
          return ret;
        }
        const ea = extended_attrs();
        const mem = const_() ||
          stringifier() ||
          attribute({ noInherit: true }) ||
          operation({ regular: true }) ||
          error("Unknown member");
        mem.extAttrs = ea;
        ret.members.push(mem);
      }
    }

    function interface_(opts) {
      const base = consume("interface");
      if (!base) return;
      const ret = mixin_rest(opts) ||
        interface_rest(opts) ||
        error("Interface has no proper body");
      ret.trivia.base = base.trivia;
      return ret;
    }

    function namespace({ partialModifier = null } = {}) {
      const base = consume("namespace");
      if (!base) return;
      const trivia = { base: base.trivia };
      const name = consume(ID) || error("No name for namespace");
      trivia.name = name.trivia;
      const mems = [];
      const ret = current = {
        type: "namespace",
        name: partialModifier ? name.value : sanitize_name(name.value, "namespace"),
        escapedName: name.value,
        partial: partialModifier,
        members: mems,
        trivia
      };
      const open = consume("{") || error("Bodyless namespace");
      trivia.open = open.trivia;
      while (true) {
        const close = consume("}");
        if (close) {
          trivia.close = close.trivia;
          const termination = consume(";") || error("Missing semicolon after namespace");
          trivia.termination = termination.trivia;
          return ret;
        }
        const ea = extended_attrs();
        const mem = attribute({ noInherit: true, readonly: true }) ||
          operation({ regular: true }) ||
          error("Unknown member");
        mem.extAttrs = ea;
        ret.members.push(mem);
      }
    }

    function partial() {
      const token = consume("partial");
      if (!token) return;
      const partialModifier = { trivia: token.trivia };
      return dictionary({ partialModifier }) ||
        interface_({ partialModifier }) ||
        namespace({ partialModifier }) ||
        error("Partial doesn't apply to anything");
    }

    function dictionary({ partialModifier = null } = {}) {
      const base = consume("dictionary");
      if (!base) return;
      const trivia = { base: base.trivia };
      const name = consume(ID) || error("No name for dictionary");
      trivia.name = name.trivia;
      const mems = [];
      const ret = current = {
        type: "dictionary",
        name: partialModifier ? name.value : sanitize_name(name.value, "dictionary"),
        escapedName: name.value,
        partial: partialModifier,
        members: mems,
        trivia
      };
      if (!partialModifier) ret.inheritance = inheritance() || null;
      const open = consume("{") || error("Bodyless dictionary");
      trivia.open = open.trivia;
      while (true) {
        const close = consume("}");
        if (close) {
          trivia.close = close.trivia;
          const termination = consume(";") || error("Missing semicolon after dictionary");
          trivia.termination = termination.trivia;
          return ret;
        }
        const ea = extended_attrs();
        const required = consume("required");
        const typ = type_with_extended_attributes("dictionary-type") || error("No type for dictionary member");
        const name = consume(ID) || error("No name for dictionary member");
        const dflt = default_() || null;
        if (required && dflt) error("Required member must not have a default");
        const member = {
          type: "field",
          name: unescape(name.value),
          escapedName: name.value,
          required: required ? { trivia: required.trivia } : null,
          idlType: typ,
          extAttrs: ea,
          default: dflt,
          trivia: {
            name: name.trivia
          }
        };
        ret.members.push(member);
        const termination = consume(";") || error("Unterminated dictionary member");
        member.trivia.termination = termination.trivia;
      }
    }

    function enum_() {
      const base = consume("enum");
      if (!base) return;
      const trivia = { base: base.trivia };
      const name = consume(ID) || error("No name for enum");
      trivia.name = name.trivia;
      const vals = [];
      const ret = current = {
        type: "enum",
        name: sanitize_name(name.value, "enum"),
        escapedName: name.value,
        values: vals,
        trivia
      };
      const open = consume("{") || error("Bodyless enum");
      trivia.open = open.trivia;
      let value_expected = true;
      while (true) {
        const close = consume("}");
        if (close) {
          trivia.close = close.trivia;
          if (!ret.values.length) error("No value in enum");
          const termination = consume(";") || error("No semicolon after enum");
          trivia.termination = termination.trivia;
          return ret;
        }
        else if (!value_expected) {
          error("No comma between enum values");
        }
        const val = consume(STR) || error("Unexpected value in enum");
        val.value = val.value.slice(1, -1);
        ret.values.push(val);
        val.separator = untyped_consume(",") || null;

        value_expected = !!val.separator;
      }
    }

    function typedef() {
      const base = consume("typedef");
      if (!base) return;
      const trivia = { base: base.trivia };
      const ret = {
        type: "typedef"
      };
      ret.idlType = type_with_extended_attributes("typedef-type") || error("No type in typedef");
      const name = consume(ID) || error("No name in typedef");
      ret.name = sanitize_name(name.value, "typedef");
      ret.escapedName = name.value,
      trivia.name = name.trivia;
      current = ret;
      const termination = consume(";") || error("Unterminated typedef");
      trivia.termination = termination.trivia;
      ret.trivia = trivia;
      return ret;
    }

    function includes() {
      const start_position = consume_position;
      const target = consume(ID);
      if (!target) return;
      const trivia = { target: target.trivia };
      const includesToken = consume("includes");
      if (includesToken) {
        trivia.includes = includesToken.trivia;
        const ret = {
          type: "includes",
          target: target.value
        };
        const imp = consume(ID) || error("Incomplete includes statement");
        trivia.mixin = imp.trivia;
        ret.includes = imp.value;
        ret.trivia = trivia;
        const termination = consume(";") || error("No terminating ; for includes statement");
        trivia.termination = termination.trivia;
        return ret;
      } else {
        // rollback
        unconsume(start_position);
      }
    }

    function definition() {
      return callback() ||
        interface_() ||
        partial() ||
        dictionary() ||
        enum_() ||
        typedef() ||
        includes() ||
        namespace();
    }

    function definitions() {
      if (!tokens.length) return [];
      const defs = [];
      while (true) {
        const ea = extended_attrs();
        const def = definition();
        if (!def) {
          if (ea) error("Stray extended attributes");
          break;
        }
        def.extAttrs = ea;
        defs.push(def);
      }
      defs.push(consume("eof"));
      return defs;
    }
    const res = definitions();
    if (consume_position < tokens.length) error("Unrecognised tokens");
    return res;
  }

  const obj = {
    parse(str) {
      const tokens = tokenise(str);
      return parse(tokens);
    }
  };

  if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
    module.exports = obj;
  } else if (typeof define === 'function' && define.amd) {
    define([], () => obj);
  } else {
    (self || window).WebIDL2 = obj;
  }
})();
