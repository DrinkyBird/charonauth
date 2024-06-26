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

var Promise = require('bluebird');
var _ = require('lodash');

var crypto = require('crypto');
require('date-utils');
var Sequelize = require('sequelize');
const { v4: uuidv4 } = require('uuid');

var Config = require('./config');
var countries = require('./countries');
var error = require('./error');
var srp = require('../srp');

// Lookup table for action types
var prettyTypes = {
	auth: "Authenticated on game server",
	login: "Logged into website",
	logout: "Logged out of website",
	editUser: "Edited user data",
	editProfile: "Edited user profile data",
	create: "User created"
};

// DBConn
//
// Handles communication with the database.

// Constructor
var DBConn = function(config) {
	var self = this;

	return new Promise(function(resolve, reject) {
		self.config = new Config(config, {
			storage: 'charonauth.db',
			uri: undefined
		});

		if (!self.config.get('uri')) {
			reject(new Error("Missing uri in database configuration."));
			return;
		}

		// Sequelize options
		var options = {
			logging: false,
			storage: self.config.get('storage')
		};

		// Create the Sequelize instance
		try {
			self.db = new Sequelize(self.config.get('uri'), options);
			resolve();
		} catch (e) {
			reject(e);
		}
	}).then(function() {
		return self.db.authenticate();
	}).then(function() {
		// User is used for user information vital for a functioning user
		self.User = self.db.define('User', {
			username: Sequelize.STRING,
			email: Sequelize.STRING,
			verifier: Sequelize.BLOB,
			salt: Sequelize.BLOB,
			// OWNER, MASTER and OP can see server logs, edit user profiles and
			// can verify users.
			// OWNER and MASTER can give or remove OP access to any user.
			// OWNER can give or remove OWNER or MASTER status to any user.
			access: Sequelize.ENUM('OWNER', 'MASTER', 'OP', 'USER', 'UNVERIFIED'),
			// A setting that an administrator can set that governs if a user
			// shows up on the site and can log in or not.
			active: Sequelize.BOOLEAN
		});
		self.User.prototype.getGravatar = function() {
			var md5 = crypto.createHash('md5');
			return md5.update(this.email.toLowerCase(), 'ascii').digest('hex');
		};
		self.User.prototype.setPassword = function(password) {
			var usernameBuffer = Buffer.from(this.username.toLowerCase(), 'ascii');
			var passwordBuffer = Buffer.from(password, 'ascii');

			var params = srp.params['2048'];
			this.salt = crypto.randomBytes(4);
			this.verifier = srp.computeVerifier(params, this.salt, usernameBuffer, passwordBuffer);
		};

		// Session is used for authentication sessions
		self.Session = self.db.define('Session', {
			session: Sequelize.INTEGER,
			ephemeral: Sequelize.BLOB,
			secret: Sequelize.BLOB
		});

		self.User.hasMany(self.Session);
		self.Session.belongsTo(self.User);

		// Verify is used to store user verification attempts
		self.Verify = self.db.define('Verify', {
			token: Sequelize.STRING
		});

		self.User.hasOne(self.Verify);
		self.Verify.belongsTo(self.User);

		// Reset is used to store password reset attempts
		self.Reset = self.db.define('Reset', {
			token: Sequelize.STRING
		});

		self.User.hasOne(self.Reset);
		self.Reset.belongsTo(self.User);

		// Action is used to store actions of every user in the system
		self.Action = self.db.define('Action', {
			type: Sequelize.ENUM('auth', 'login', 'logout', 'edit', 'create'),
			ip: Sequelize.BLOB,
			before: Sequelize.STRING,
			after: Sequelize.STRING
		});
		self.Action.prototype.getPrettyType = function() {
			if (this.type in prettyTypes) {
				return prettyTypes[this.type];
			} else {
				return "Unknown action";
			}
		};

		self.User.hasMany(self.Action);
		self.User.hasMany(self.Action, {as: 'Whom', foreignKey: 'WhomId'});
		self.Action.belongsTo(self.User);
		self.Action.belongsTo(self.User, {as: 'Whom', foreignKey: 'WhomId'});

		// Profile is used for incidental user information.
		self.Profile = self.db.define('Profile', {
			clan: Sequelize.STRING,
			clantag: Sequelize.STRING,
			contactinfo: Sequelize.STRING,
			country: Sequelize.STRING,
			gravatar: {type: Sequelize.ENUM('identicon', 'monsterid', 'wavatar', 'retro'), allowNull: true},
			location: Sequelize.STRING,
			message: Sequelize.STRING,
			username: Sequelize.STRING,
			// A setting that a user can set that governs if their profile is visible.
			visible: {type: Sequelize.BOOLEAN, defaultValue: true},
			// A setting that a user can set that governs if their authentications
			// should be publicly visible or not.
			visible_lastseen: {type: Sequelize.BOOLEAN, defaultValue: true}
		});
		self.Profile.prototype.getCountry = function() {
			if (_.isNull(this.country) || _.isEmpty(this.country)) {
				return null;
			} else {
				return countries.getData(this.country, 'name.common', null);
			}
		};
		self.Profile.prototype.getFlag = function() {
			if (_.isNull(this.country) || _.isEmpty(this.country)) {
				return null;
			} else if (countries.getData(this.country)) {
				return countries.getData(this.country).cca3.toLowerCase();
			}
		};

		self.User.hasOne(self.Profile);
		self.Profile.belongsTo(self.User);

		// FIXME: Don't do this automatically
		return self.db.sync();
	}).then(function() {
		return self;
	});
};

DBConn.prototype.addUser = function(username, password, email, access) {
	var self = this;

	var usernameBuffer = Buffer.from(username.toLowerCase(), 'ascii');
	var passwordBuffer = Buffer.from(password, 'ascii');

	var params = srp.params['2048'];
	var salt = crypto.randomBytes(4);
	var verifier = srp.computeVerifier(params, salt, usernameBuffer, passwordBuffer);

	return Promise.all([
		this.User.create({
			username: username.toLowerCase(),
			verifier: verifier,
			salt: salt,
			email: email,
			access: access || 'UNVERIFIED',
			// New user is only active if they're not unverified
			active: ((access || 'UNVERIFIED') === 'UNVERIFIED') ? false : true
		}),
		this.Profile.create({
			username: username
		})
	]).spread(function(user, profile) {
		return user.setProfile(profile);
	}).then(function(profile) {
		return self.User.findOne({
			where: {id: profile.UserId},
			include: [self.Profile]
		});
	});
};
DBConn.prototype.findUser = function(username) {
	return this.User.findOne({ where: { username: username.toLowerCase() }})
	.then(function(data) {
		if (data === null) {
			throw new error.UserNotFound("User not found", username);
		} else {
			return data;
		}
	});
};

// Attempts to verify a user in when the password is delivered directly to
// the application (i.e. through a web login form).
DBConn.prototype.verifyUser = function(identity, password) {
	var passwordBuffer = Buffer.from(password, 'ascii');

	return this.User.findOne({
		where: Sequelize.or(
			{ username: identity.toLowerCase() },
			{ email: identity.toLowerCase() }
		)
	}).then(function(data) {
		if (data === null) {
			throw new error.UserNotFound("User not found", identity);
		} else {
			var params = srp.params['2048'];

			var usernameBuffer = Buffer.from(data.username.toLowerCase(), 'ascii');
			var verifier = srp.computeVerifier(params, data.salt, usernameBuffer, passwordBuffer);

			if (verifier.toString('hex') !== data.verifier.toString('hex')) {
				throw new error.LoginAuthFailed("Login failed");
			} else {
				return data;
			}
		}
	});
};
DBConn.prototype.newSession = function(username) {
	var self = this;

	return Promise.all([
		this.findUser(username),
		new Promise(function(resolve, reject) {
			var sessionBuffer = crypto.randomBytes(4);
			var sessionID = sessionBuffer.readUInt32LE(0);
			resolve(sessionID);
		}).then(function(sessionID) {
			return self.Session.create({ session: sessionID });
		})
	]).spread(function(user, session) {
		return session.setUser(user);
	});
};
DBConn.prototype.findSession = function(session, timeout) {
	return Promise.resolve(this.Session.findOne({ where: { "session": session }}))
	.then(function(sess) {
		if (sess === null) {
			throw new error.SessionNotFound("Session not found", session);
		}

		// A session that is expired is not a valid session.
		var diff = sess.createdAt.getSecondsBetween(new Date());
		if (diff > timeout) {
			throw new Error('Session has expired');
		}

		// Get data associated with session.
		return [sess, sess.getUser()];
	}).spread(function(sess, user) {
		if (user === null) {
			throw new Error("Session is not attached to User");
		} else if (user.access === "UNVERIFIED") {
			throw new Error("Session belongs to UNVERIFIED User");
		}

		return sess;
	});
};
DBConn.prototype.setEphemeral = function(session, ephemeral, secret, callback) {
	return this.Session.findOne({
		replacements: [ session ],
		where: Sequelize.literal('session = ? AND ephemeral IS NULL AND secret IS NULL')
	}).then(function(sess) {
		if (sess === null) {
			throw new Error("Session not found");
		}

		return sess.update({
			ephemeral: ephemeral,
			secret: secret
		});
	});
};

// Either create a new verify token or reuse an existing one.
DBConn.prototype.newVerify = function(user) {
	return Promise.resolve(this.Verify.findOrCreate({
		where: {
			UserId: user.id
		}
	})).spread(function(verify, created) {
		return verify.update({
			token: uuidv4()
		});
	});
};

// Find a valid verify token.
DBConn.prototype.findVerify = function(token) {
	return Promise.resolve(this.Verify.findOne({
		where: {token: token}
	})).then(function(reset) {
		if (reset === null) {
			throw new error.VerifyNotFound("Verify not found");
		}

		// Reset tokens expire after 24 hours
		var diff = reset.updatedAt.getDaysBetween(new Date());
		if (diff !== 0) {
			throw new error.VerifyNotFound("Verify has expired");
		}

		return reset;
	});
};

// Either create a new reset token or reuse an existing one.
DBConn.prototype.newReset = function(user) {
	return Promise.resolve(this.Reset.findOrCreate({
		where: {
			UserId: user.id
		}
	})).spread(function(reset, _) {
		return reset.update({
			token: uuidv4()
		});
	});
};

// Find a valid reset token.
DBConn.prototype.findReset = function(token) {
	return Promise.resolve(this.Reset.findOne({
		where: {token: token}
	})).then(function(reset) {
		if (reset === null) {
			throw new error.ResetNotFound("Reset not found");
		}

		// Reset tokens expire after 24 hours
		var diff = reset.updatedAt.getDaysBetween(new Date());
		if (diff !== 0) {
			throw new error.ResetNotFound("Reset has expired");
		}

		return reset;
	});
};

module.exports = DBConn;
