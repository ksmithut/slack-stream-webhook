/**
 * @interface
 * @template TValue
 * @typedef {object} Node
 * @property {string} key
 * @property {TValue} value
 * @property {Node<TValue>?} next
 * @property {Node<TValue>?} prev
 */

/**
 * @template TSchema
 * @param {import('zod').ZodSchema<TSchema>} schema
 * @param {object} [options]
 * @param {number} [options.max]
 */
export default function createTypedLRUCache (schema, { max = 1000 } = {}) {
  let count = 0
  /** @type {Map<string, Node<TSchema>>} */
  const map = new Map()
  /** @type {Node<TSchema>?} */
  let head = null
  /** @type {Node<TSchema>?} */
  let tail = null

  /**
   * @param {string} key
   * @param {TSchema} value
   */
  function insert (key, value) {
    /** @type {Node<TSchema>} */
    const node = { key, value, next: null, prev: null }
    count += 1
    map.set(key, node)
    if (!head) {
      head = node
      tail = node
    } else {
      head.prev = node
      node.next = head
      head = node
    }
  }

  /**
   * @param {string} key
   */
  function use (key) {
    const node = map.get(key)
    if (!node) return
    if (node === head) return
    if (node === tail) {
      if (node.prev) node.prev.next = null
      tail = node.prev
    } else {
      if (node.prev) node.prev.next = node.next
      if (node.next) node.next.prev = node.prev
    }
    node.prev = null
    node.next = head
    if (head) head.prev = node
    head = node
  }

  function evict () {
    if (!tail) return
    if (head === tail) {
      head = null
      tail = null
    } else {
      if (tail.prev) tail.prev.next = null
      tail = tail.prev
    }
    count -= 1
    if (tail) map.delete(tail.key)
  }

  const cache = Object.freeze({
    /**
     * @param {string} key
     */
    get (key) {
      const node = map.get(key)
      if (!node) return
      use(node.key)
      return node.value
    },
    /**
     * @param {string} key
     * @param {TSchema} value
     */
    set (key, value) {
      value = schema.parse(value)
      const node = map.get(key)
      if (node) {
        node.value = value
        use(key)
        map.set(key, node)
      } else {
        if (count >= max) evict()
        insert(key, value)
      }
    },
    /** @returns {Generator<[string, TSchema]>} */
    *entries () {
      let curr = head
      while (curr) {
        yield [curr.key, curr.value]
        curr = curr.next
      }
    },
    *values () {
      for (const [_, value] of cache.entries()) yield value
    },
    *keys () {
      for (const [key] of cache.entries()) yield key
    }
  })
  return cache
}
