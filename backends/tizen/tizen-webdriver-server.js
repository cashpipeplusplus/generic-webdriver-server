#!/usr/bin/env node
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


let baseModule;
try {
  // To support easy development when making changes in the source repo, we
  // first try looking for a copy of the base module using a relative path.  In
  // this context, we prefer the local copy over one that may already be
  // installed.
  baseModule = require('../../generic-webdriver-server');
} catch (error) {
  if (!error.message.includes('Cannot find module')) {
    throw error;
  }

  // When this module is running in an installed context, we fall back to
  // requiring the installed base module by name.
  baseModule = require('generic-webdriver-server');
}

const {GenericSingleSessionWebDriverServer, yargs} = baseModule;
const {loadOnTizen, addTizenArgs} = require('./tizen-utils');

/** WebDriver server backend for Tizen */
class TizenWebDriverServer extends GenericSingleSessionWebDriverServer {
  constructor() {
    super();
  }

  /** @override */
  async navigateToSingleSession(url) {
    await loadOnTizen(this.flags, this.log, url);
  }

  /** @override */
  async closeSingleSession() {
    // Send the device back to the home screen.
    await loadOnTizen(this.flags, this.log, null);
  }
}

addTizenArgs(yargs);
const server = new TizenWebDriverServer();
server.listen();
