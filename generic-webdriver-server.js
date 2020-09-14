/**
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const {Console} = require('console');

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const util = require('util');
const yargs = require('yargs');

const randomBytes = util.promisify(crypto.randomBytes);
const NUM_RANDOM_ID_BYTES = 16;  // AKA 128 bits, the same as a UUID.

// Makes it more obvious why we multiply timeouts by 1000 for setTimeout.
const MILLISECONDS_PER_SECOND = 1000;

// Register standard command-line arguments generated by our Selenium patches.
// Backends can register additional arguments.
yargs
    .strict()
    .option('port', {
      description: 'port to listen on',
      type: 'number',
      demandOption: true,
    })
    .option('log-path', {
      description: 'write server log to file instead of stderr',
      type: 'string',
    })
    .option('idle-timeout-seconds', {
      description: 'A timeout for idle sessions',
      type: 'number',
      default: 120,
    })
    .check((flags) => {
      if (Math.floor(flags.port) != flags.port) {
        throw new Error('port must be an integer!');
      }

      if (flags.port < 1 || flags.port > 65535) {
        throw new Error('port must be between 1 and 65535!');
      }

      return true;
    });

/**
 * A container for general WebDriver responses.  Each has a value and a status
 * code.
 */
class GenericWebDriverResponse {
  /**
   * @param {?} value Usually an object, but occasionally a string.  The exact
   *   format depends on the command we're responding to, and is defined in the
   *   W3C WebDriver spec.  https://www.w3.org/TR/webdriver2/
   * @param {number} httpStatusCode The HTTP status code associated with the
   *   response.  The value status codes are also defined in the W3C WebDriver
   *   spec.
   */
  constructor(value, httpStatusCode) {
    /** @type {?} */
    this.value = value;
    /** @type {number} */
    this.httpStatusCode = httpStatusCode;
  }
}

/**
 * A successful response, with HTTP status 200 (OK).
 */
class Success extends GenericWebDriverResponse {
  /**
   * @param {?} value Usually an object, but occasionally a string.  The exact
   *   format depends on the command we're responding to, and is defined in the
   *   W3C WebDriver spec.  https://www.w3.org/TR/webdriver2/
   */
  constructor(value) {
    super(value, 200);
  }
}

/**
 * A "session not created" error as defined by the spec.
 * https://www.w3.org/TR/webdriver2/#dfn-session-not-created
 */
class SessionNotCreatedError extends GenericWebDriverResponse {
  constructor() {
    super({error: 'session not created'}, 500);
  }
}

/**
 * An "unknown command" error as defined by the spec.
 * https://www.w3.org/TR/webdriver2/#dfn-unknown-command
 */
class UnknownCommandError extends GenericWebDriverResponse {
  constructor() {
    super({error: 'unknown command'}, 404);
  }
}

/**
 * An "invalid argument" error as defined by the spec.
 * https://www.w3.org/TR/webdriver2/#dfn-invalid-argument
 */
class InvalidArgumentError extends GenericWebDriverResponse {
  constructor() {
    super({error: 'invalid argument'}, 400);
  }
}

/**
 * An "invalid session id" error as defined by the spec.
 * https://www.w3.org/TR/webdriver2/#dfn-invalid-session-id
 */
class InvalidSessionIdError extends GenericWebDriverResponse {
  constructor() {
    super({error: 'invalid session id'}, 404);
  }
}

/**
 * An "unable to capture screen" error as defined by the spec.
 * https://www.w3.org/TR/webdriver2/#dfn-unable-to-capture-screen
 */
class UnableToCaptureScreenError extends GenericWebDriverResponse {
  constructor() {
    super({error: 'unable to capture screen'}, 500);
  }
}

/**
 * An "unknown error" as defined by the spec.
 * https://www.w3.org/TR/webdriver2/#dfn-unknown-error
 */
class UnknownError extends GenericWebDriverResponse {
  constructor() {
    super({error: 'unknown error'}, 500);
  }
}

/**
 * A server base class which implements part of the W3C WebDriver protocol.
 *
 * Backend subclasses provide method overrides to implement the functionality
 * for a particular type of device or platform:
 *  - ready
 *  - shutdown (optional)
 *  - createSession
 *  - navigateTo
 *  - screenshot (optional)
 *  - getTitle
 *  - closeSession
 *
 * https://www.w3.org/TR/webdriver2/
 */
class GenericWebDriverServer {
  constructor() {
    /**
     * Parsed command-line flags.
     *
     * @type {!object<string, ?>}
     */
    this.flags = yargs.argv;

    /** @type {Console} */
    this.log = null;

    /** @type {!express.App} */
    this.app = express();

    /** @type {!express.Server} */
    this.server = null;

    this.initLogging_();
    this.initWebDriverProtocol_();
  }

  /**
   * Initialize the logging system and this.log.
   *
   * @private
   */
  initLogging_() {
    let logFile;
    if (this.flags.logPath) {
      // Log to a file.
      logFile = fs.createWriteStream(this.flags.logPath);
    } else {
      // Log to stderr by default.
      logFile = process.stderr;
    }

    // Normally, some log levels go to stdout, other to stderr.
    // Log all levels to the same place.
    this.log = new Console({
      stdout: logFile,
      stderr: logFile,
    });
  }

  /**
   * Initialize the WebDriver protocol handlers using express.
   *
   * @private
   */
  initWebDriverProtocol_() {
    // This middle-ware will parse incoming JSON-formatted requests and place
    // the parsed data in request.body.
    this.app.use(express.json());

    // This is a handler that logs the request before passing it along to the
    // next handler.
    this.app.use((expressRequest, expressResponse, next) => {
      this.log.info(
          expressRequest.method, expressRequest.url, expressRequest.body);
      next();
    });

    /**
     * Wrap a simplified callback and handle the common details of the protocol.
     * Extracts URL parameters and parses JSON request bodies to provide to the
     * callback, then awaits the callback.  The callback returns a
     * GenericWebDriverResponse subclass, which is then formatted according to
     * the structure detailed in W3C WebDriver protocol spec and formatted in
     * JSON.  Thrown errors are also handled and converted into
     * correctly-formatted errors responses in JSON.
     *
     * @param {function(object, object):!Promise<!GenericWebDriverResponse>} fn
     *   The callback which will handle the request.  Takes URL parameters and
     *   JSON parameters from the POST body.
     * @return {express.middlewareCallback}
     */
    const apiWrapper = (fn) => {
      return async (expressRequest, expressResponse, next) => {
        let response;
        try {
          // These are named parts of the URL.
          const params = expressRequest.params;

          // These are JSON parameters from the POST body.
          const body = expressRequest.body;

          // This should return a GenericWebDriverResponse.
          response = await fn(params, body);
        } catch (error) {
          // This _may_ be a GenericWebDriverResponse if it was thrown on
          // purpose.  Otherwise, it should be converted into one.
          if (error instanceof GenericWebDriverResponse) {
            response = error;
          } else {
            this.log.error('Caught error:', error);
            response = new UnknownError();
          }
        }

        // Send the HTTP status code indicated in the response.
        expressResponse.status(response.httpStatusCode);
        // All WebDriver responses are spec'd to come inside {value: ...} for
        // some reason.
        expressResponse.json({value: response.value});
      };
    };

    // https://www.w3.org/TR/webdriver2/#dfn-status
    this.app.get('/status', apiWrapper(async () => {
      const ready = await this.ready();
      return new Success({
        ready,
        message: ready ? 'ok' : 'busy',
      });
    }));

    // Not spec'd, but sent by Selenium client on driver.close() and supported
    // by ChromeDriver.
    this.app.get('/shutdown', apiWrapper(async () => {
      await this.shutdown();
      this.server.close();
      return new Success({});
    }));

    // https://www.w3.org/TR/webdriver2/#dfn-new-sessions
    this.app.post('/session', apiWrapper(async () => {
      // NOTE: We could get the client's requested capabilities from the
      // express request if any subclasses turn out to need them.
      const sessionId = await this.createSession();
      if (!sessionId) {
        return new SessionNotCreatedError();
      }

      // NOTE: The capabilities field of the response is meant to return the
      // capabilities of the device, but it seems that in practice, it is not
      // critical to do so. So we'll be lazy until there's a reason not to be.
      const capabilities = {};
      return new Success({sessionId, capabilities});
    }));

    // https://www.w3.org/TR/webdriver2/#dfn-navigate-to
    this.app.post('/session/:sessionId/url',
        apiWrapper(async (params, body) => {
          if (!body.url) {
            return new InvalidArgumentError();
          }

          await this.navigateTo(params.sessionId, body.url);
          return new Success({});
        }));

    // https://www.w3.org/TR/webdriver2/#dfn-take-screenshot
    this.app.get('/session/:sessionId/screenshot',
        apiWrapper(async (params) => {
          const png = await this.screenshot(params.sessionId);
          return new Success(png.toString('base64'));
        }));

    // https://www.w3.org/TR/webdriver2/#dfn-close-window
    this.app.delete('/session/:sessionId/window', apiWrapper(async (params) => {
      await this.closeSession(params.sessionId);
      return new Success({});
    }));

    // https://www.w3.org/TR/webdriver2/#dfn-delete-session
    this.app.delete('/session/:sessionId', apiWrapper(async (params) => {
      await this.closeSession(params.sessionId);
      return new Success({});
    }));

    // https://www.w3.org/TR/webdriver2/#dfn-get-title
    this.app.get('/session/:sessionId/title', apiWrapper(async (params) => {
      const title = await this.getTitle(params.sessionId);
      return new Success(title);
    }));

    // This is a catch-all for routes we don't handle.
    // https://www.w3.org/TR/webdriver2/#routing-requests
    this.app.use(apiWrapper(() => {
      return new UnknownCommandError();
    }));
  }

  /**
   * Start the server on the port specified on the command-line.
   * Does not return until the server is shut down.
   */
  listen() {
    this.log.info('Listening on port ' + this.flags.port);
    this.server = this.app.listen(this.flags.port);
  }


  // Methods below here should be overridden by subclasses.  All can be async.

  /**
   * Check if the server is ready and can create a session.
   * Overridden by a subclass.
   *
   * @return {!Promise<boolean>} True if the system is ready and can create a
   *   session.  If concurrent sessions are not supported, this should return
   *   false while a session is in use.
   */
  async ready() {
    return false;
  }

  /**
   * Shut down the server after closing any open sessions.
   * Overridden by a subclass.  Optional.
   *
   * @return {!Promise}
   */
  async shutdown() {}

  /**
   * Create a new session.
   * Overridden by a subclass.
   *
   * @return {!Promise<?string>} The session ID, which must be non-null and
   *   non-empty.  A null or empty value will be converted into an error.
   */
  async createSession() {
    return null;
  }

  /**
   * Navigate to a specific URL in a specific session.
   * Overridden by a subclass.
   *
   * @param {string} sessionId The ID of the session.
   * @param {string} url The URL to navigate to.
   * @return {!Promise}
   * @throws {InvalidSessionIdError} on invalid session
   */
  async navigateTo(sessionId, url) {
    throw new InvalidSessionIdError();
  }

  /**
   * Take a full-page screenshot of the browsing window of a specific session.
   * Overridden by a subclass.  Optional.
   *
   * @param {string} sessionId The ID of the session.
   * @return {!Promise<Buffer>} A PNG screenshot.
   * @throws {InvalidSessionIdError} on invalid session
   * @throws {UnableToCaptureScreenError} if screenshots are not supported
   */
  async screenshot(sessionId) {
    throw new UnableToCaptureScreenError();
  }

  /**
   * Get the page title for the session ID. This is sometimes used as a ping to
   * keep the connection alive, and does not have to be accurate.
   * Overridden by a subclass.
   *
   * @param {string} sessionId The ID of the session.
   * @return {!Promise<string>}
   * @throws {InvalidSessionIdError} on invalid session
   */
  async getTitle(sessionId) {
    throw new InvalidSessionIdError();
  }

  /**
   * Close a specific session.  Does not throw on an unknown session ID.
   * Overridden by a subclass.
   *
   * @param {string} sessionId The ID of the session.
   * @return {!Promise}
   */
  async closeSession(sessionId) {}
}

/**
 * A server base class which extends GenericWebDriverServer by adding behavior
 * common to all single-session driver backends.  When a backend can only handle
 * one session at a time, the session ID is random, the driver is not "ready"
 * for a new session until the old one is closed, and the session is
 * automatically cleaned up after it goes idle for some amount of time.
 *
 * Backend subclasses provide method overrides to implement the functionality
 * for a particular type of device or platform:
 *  - shutdownSingleSession (optional)
 *  - navigateToSingleSession
 *  - closeSingleSession
 *
 * https://www.w3.org/TR/webdriver2/
 */
class GenericSingleSessionWebDriverServer extends GenericWebDriverServer {
  constructor() {
    super();

    /** @private {string} */
    this.sessionId_ = '';

    /** @private {Timeout} */
    this.timeout_ = null;
  }

  /** @override */
  async ready() {
    // We're ready if there's no active session.
    return this.sessionId_ == '';
  }

  /** @override */
  async shutdown() {
    if (this.sessionId_) {
      this.closeSession(this.sessionId_);
    }

    await this.shutdownSingleSession();
  }

  /** @override */
  async createSession() {
    // If we already have an active session, we can't have another one.
    if (this.sessionId_) {
      // Returning null indicates to the base class that a session couldn't be
      // created.  It will reply with the appropriate error code.
      this.log.error('createSession() called when we were not ready!');
      return null;
    }

    // Here, we create a randomly-generated ID in hex.
    const bytes = await randomBytes(NUM_RANDOM_ID_BYTES);
    this.sessionId_ = bytes.toString('hex');
    this.log.debug('Session ID', this.sessionId_, 'created');

    // When there is no activity for a while, close the session.  This keeps
    // the device from being unavailable forever if the client vanishes.
    this.timeout_ = setTimeout(() => {
      this.log.info('Activity timeout.  Releasing session.');
      this.closeSession(this.sessionId_);
    }, this.flags.idleTimeoutSeconds * MILLISECONDS_PER_SECOND);

    return this.sessionId_;
  }

  /** @override */
  async navigateTo(sessionId, url) {
    if (!this.sessionId_ || sessionId != this.sessionId_) {
      throw new InvalidSessionIdError();
    }

    this.timeout_.refresh();

    await this.navigateToSingleSession(url);
  }

  /** @override */
  async getTitle(sessionId) {
    if (!this.sessionId_ || sessionId != this.sessionId_) {
      throw new InvalidSessionIdError();
    }

    this.timeout_.refresh();

    // This doesn't have to be real.
    return 'Title of the page';
  }

  /** @override */
  async closeSession(sessionId) {
    if (!this.sessionId_ || sessionId != this.sessionId_) {
      // Never throws, even on an invalid session ID.
      return;
    }

    this.log.debug('Session ID', this.sessionId_, 'released');
    this.sessionId_ = '';

    clearTimeout(this.timeout_);
    this.timeout_ = null;

    try {
      await this.closeSingleSession();
    } catch (error) {
      // Log the error, but don't fail the method.
      // closeSession() should never throw.
      this.log.error(error);
    }
  }

  /**
   * Shut down the server after closing the session.
   * Overridden by a subclass.  Optional.
   *
   * @return {!Promise}
   */
  async shutdownSingleSession() {}

  /**
   * Navigate to a specific URL.
   * Overridden by a subclass.
   *
   * @param {string} url The URL to navigate to.
   * @return {!Promise}
   */
  async navigateToSingleSession(url) {
    throw new InvalidSessionIdError();
  }

  /**
   * Close the session.
   * Overridden by a subclass.
   *
   * @return {!Promise}
   */
  async closeSingleSession() {
    throw new InvalidSessionIdError();
  }
}

module.exports = {
  // The base class
  GenericWebDriverServer,
  GenericSingleSessionWebDriverServer,

  // The command-line args interface
  yargs,

  // All the error types
  SessionNotCreatedError,
  UnknownCommandError,
  InvalidArgumentError,
  InvalidSessionIdError,
  UnknownError,
};
