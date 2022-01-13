// deno-lint-ignore-file no-explicit-any

import { ensureFile } from 'https://deno.land/std@0.121.0/fs/mod.ts'
import { Sha1 } from 'https://deno.land/std@0.121.0/hash/sha1.ts'
import * as path from 'https://deno.land/std@0.121.0/path/mod.ts'

///////////////////////////////////////////////////////////////////////////////////////////////////
// Errors
///////////////////////////////////////////////////////////////////////////////////////////////////

const errors = {
  Deserialize: class Deserialize extends Error {},
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// Models
///////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Represents a request
 */
class RequestInfo {
  constructor(
    public url: URL,
    public method: string,
    public headers: Headers,
    public body: string,
  ) {}

  /**
   * Build a RequestInfo given a Request object
   */
  public static async fromRequest(req: Request, url: URL) {
    const body = await req.text()
    return new RequestInfo(url, req.method, req.headers, body)
  }

  /**
   * Serialize object
   */
  public toJSON() {
    const headers: Record<string, string> = {}
    for (const [k, v] of this.headers) {
      headers[k] = v
    }

    return {
      url: this.url.toString(),
      method: this.method,
      headers,
      body: this.body,
    }
  }

  /**
   * Hash representing the request. Useful to build a filename for cache
   */
  public hash() {
    const payload = this.toJSON()
    payload.headers = {} // don't include headers in the hash or similar req will duplicate calls (e.g. user agent)
    return new Sha1().update(JSON.stringify(payload)).hex()
  }
}

/**
 * Represents a response
 */
class ResponseInfo {
  constructor(public status: number, public headers: Record<string, string>, public data: string) {}

  /**
   * Build a ResponseInfo given a Response
   */
  public static async fromResponse(res: Response) {
    const isSuccessful = res.status === 200

    const data = isSuccessful ? await res.text() : ''

    const headers = {} as Record<string, string>
    for (const [k, v] of res.headers) {
      headers[k] = v
    }

    return new ResponseInfo(res.status, headers, data)
  }

  /**
   * Whether or not the request is successful
   */
  public get isSuccessful() {
    return this.status === 200
  }

  /**
   * Serialize object
   */
  public toJSON() {
    return { status: this.status, headers: this.headers, data: this.data }
  }

  /**
   * Deserialize object
   */
  public static fromJSON(json: any) {
    try {
      return new ResponseInfo(json.status, json.headers, json.data)
    } catch {
      throw new errors.Deserialize()
    }
  }
}

/**
 * Represents the document serialized and cached on disk
 */
interface CachedItem {
  date: number
  req: any
  res: any
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// Decorators
///////////////////////////////////////////////////////////////////////////////////////////////////

export const CachableRequest =
  () => (_target: any, _propertyKey: string, descriptor: PropertyDescriptor) => {
    const method = descriptor.value

    descriptor.value = async function (req: RequestInfo) {
      const fromCache = await cache.get(req)
      if (fromCache) {
        console.log(`Cache hit ${req.method} ${req.url.toString()}`)
        return fromCache
      }

      console.log(`Cache miss ${req.method} ${req.url.toString()}`)
      const fromFetch = await method(req)

      await cache.set(req, fromFetch)
      return fromFetch
    }
  }

///////////////////////////////////////////////////////////////////////////////////////////////////
// Server
///////////////////////////////////////////////////////////////////////////////////////////////////

class Server {
  constructor(private cachedFetcher: Fetcher) {}

  public async start() {
    const server = Deno.listen({ port: 8080 })
    console.log(`HTTP webserver running. Access it at: http://localhost:8080/`)

    for await (const conn of server) {
      this.serveHttp(conn) // non blocking
    }
  }

  private async serveHttp(conn: Deno.Conn) {
    const httpConn = Deno.serveHttp(conn)
    for await (const requestEvent of httpConn) {
      const url = new URL(requestEvent.request.url)
      const reqURL = url.searchParams.get('u')
      if (!reqURL) {
        requestEvent.respondWith(
          new Response('', {
            status: 404,
          }),
        )
        return
      }

      const req = await RequestInfo.fromRequest(requestEvent.request, new URL(reqURL))
      const res = await this.cachedFetcher.fetch(req)

      requestEvent.respondWith(
        new Response(res.data, {
          status: res.status,
          headers: res.headers,
        }),
      )
    }
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// Fetcher
///////////////////////////////////////////////////////////////////////////////////////////////////

class Fetcher {
  @CachableRequest()
  public async fetch(req: RequestInfo): Promise<ResponseInfo> {
    const res = await fetch(req.url, { headers: req.headers })
    const result = await ResponseInfo.fromResponse(res)
    return result
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// Cache
///////////////////////////////////////////////////////////////////////////////////////////////////

class Cache {
  public async set(req: RequestInfo, res: ResponseInfo) {
    if (!res.isSuccessful) {
      console.log(`Skip cache response because the call was not successful`)
      return
    }

    const filepath = this.buildFilepath(req)
    await ensureFile(filepath)
    const item: CachedItem = {
      date: Date.now(),
      req: req.toJSON(),
      res: res.toJSON(),
    }
    await Deno.writeTextFile(filepath, JSON.stringify(item, null, '  '))
    console.log(`Cached ${filepath}`)
  }

  public async get(req: RequestInfo): Promise<ResponseInfo | undefined> {
    const filepath = this.buildFilepath(req)

    try {
      const resRaw = await Deno.readTextFile(filepath)
      const res: CachedItem = JSON.parse(resRaw)
      const data = ResponseInfo.fromJSON(res.res)
      return data
    } catch (err) {
      if (err instanceof Deno.errors.NotFound || err instanceof errors.Deserialize) {
        return undefined
      }

      throw err
    }
  }

  private buildFilepath(req: RequestInfo) {
    const result = path.join(`./tmp/cache`, req.url.host, `${req.hash()}.json`)
    return result
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// Main
///////////////////////////////////////////////////////////////////////////////////////////////////

const cache = new Cache()

function main() {
  const fetcher = new Fetcher()
  const server = new Server(fetcher)

  server.start()
}

main()
