/*
 *  Charon: A game authentication server
 *  Copyright (C) 2014  Alex Mayfield
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU Affero General Public License as published by
 *  the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU Affero General Public License for more details.
 *
 *  You should have received a copy of the GNU Affero General Public License
 *  along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/* jshint node: true */
"use strict";

var winston = require('winston');

var Config = require('./config');

function Logger(config) {
	this.config = new Config(config, {
		file: undefined,
		verbose: false
	});

	this.logger = winston.createLogger({
		transports: [
			new winston.transports.Console({
				format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
				level: this.config.getBool('verbose') ? 'verbose' : 'info'
			})
		]
	});

	this.log = this.logger.log;
	this.verbose = (s) => { this.logger.log("verbose", s); };
	this.info = (s) => { this.logger.log("info", s); };
	this.warn = (s) => { this.logger.log("warn", s); };
	this.error = (s) => { this.logger.log("error", s); };

	// Log to a file if supplied
	if (this.config.get('file')) {
		this.logger.add(new winston.transports.File({
			filename: this.config.get('file'),
			json: false,
			timestamp: function() {
				return new Date().toISOString() + ' [' + process.pid + ']';
			}
		}));
	}
}

module.exports = Logger;
