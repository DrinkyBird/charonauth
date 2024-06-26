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

var buffer = require("buffer");
var util = require("util");

// Protocol Constants
var SERVER_NEGOTIATE = 0xD003CA01;
var AUTH_NEGOTIATE = 0xD003CA10;
var SERVER_EPHEMERAL = 0xD003CA02;
var AUTH_EPHEMERAL = 0xD003CA20;
var SERVER_PROOF = 0xD003CA03;
var AUTH_PROOF = 0xD003CA30;
var ERROR_USER = 0xD003CAFF; // Protocol v1
var ERROR_CLIENTSESSION = 0xD003CAFF; // Protocol v2
var ERROR_SESSION = 0xD003CAEE;

function readString(buf, offset, encoding) {
	if (offset === undefined) {
		offset = 0;
	}

	if (encoding === undefined) {
		encoding = 'utf8';
	}

	var z = buf.indexOf("\0", offset, encoding);
	if (z === -1) {
		throw new TypeError("Null-terminator not found in buffer");
	}

	return buf.toString(encoding, offset, z);
}

function writeString(buf, str, offset, encoding) {
	if (offset === undefined) {
		offset = 0;
	}

	if (encoding === undefined) {
		encoding = 'utf8';
	}

	var string = Buffer.from(str, encoding);
	string.copy(buf, offset);
	buf.writeUInt8(0, offset + string.length);
}

// Server Negotiation
//
// Header, UInt32
// Maximum Protocol Version, UInt8
// Client Session ID, UInt32
// Username, String
var serverNegotiate = {
	marshall: function(data) {
		var buf = Buffer.alloc(9 + Buffer.byteLength(data.username, 'ascii') + 1);

		buf.writeUInt32LE(SERVER_NEGOTIATE, 0);
		buf.writeUInt8(data.version, 4);
		buf.writeUInt32LE(data.clientSession, 5);
		writeString(buf, data.username, 9, 'ascii');

		return buf;
	},
	unmarshall: function(buf) {
		if (buf.readUInt32LE(0) !== SERVER_NEGOTIATE) {
			throw new TypeError("Buffer is not a SERVER_NEGOTIATE packet");
		}

		var version = buf.readUInt8(4);
		if (version !== 1 && version !== 2) {
			throw new TypeError("Buffer is unknown version of protocol");
		}

		var data = {
			clientSession: buf.readUInt32LE(5),
			username: readString(buf, 9, 'ascii'),
			version: version
		};

		return data;
	}
};

// Auth server negotiation
//
// Header, UInt32
// Protocol Version, UInt8
// Client Session ID, UInt32
// Session ID, UInt32
// Salt Length, UInt8
// Salt, Bytes
// Username, String
var authNegotiate = {
	marshall: function(data) {
		var buf = Buffer.alloc(14 + data.salt.length + Buffer.byteLength(data.username, 'ascii') + 1);

		buf.writeUInt32LE(AUTH_NEGOTIATE, 0);
		buf.writeUInt8(1, 4);
		buf.writeUInt32LE(data.clientSession, 5);
		buf.writeUInt32LE(data.session, 9);
		buf.writeUInt8(data.salt.length, 13);
		data.salt.copy(buf, 14);
		writeString(buf, data.username, 14 + data.salt.length, 'ascii');

		return buf;
	},
	unmarshall: function(buf) {
		if (buf.readUInt32LE(0) !== AUTH_NEGOTIATE) {
			throw new TypeError("Buffer is not a AUTH_NEGOTIATE packet");
		}
		if (buf.readUInt8(4) !== 1) {
			throw new TypeError("Buffer is incorrect version of protocol");
		}

		// Salt
		var salt_len = buf.readUInt8(13);
		var salt = Buffer.alloc(salt_len);
		buf.copy(salt, 0, 14, 14 + salt_len);

		var data = {
			clientSession: buf.readUInt32LE(5),
			session: buf.readUInt32LE(9),
			salt: salt,
			username: readString(buf, 14 + salt_len, 'ascii')
		};

		return data;
	}
};

// Server ephemeral
// UInt32, UInt16, Buffer
var serverEphemeral = {
	marshall: function(data) {
		var buf = Buffer.alloc(10 + data.ephemeral.length);

		buf.writeUInt32LE(SERVER_EPHEMERAL, 0);
		buf.writeUInt32LE(data.session, 4);
		buf.writeUInt16LE(data.ephemeral.length, 8);
		data.ephemeral.copy(buf, 10);

		return buf;
	},
	unmarshall: function(buf) {
		if (buf.readUInt32LE(0) !== SERVER_EPHEMERAL) {
			throw new TypeError("Buffer is not a SERVER_EPHEMERAL packet");
		}

		var ephemeralLength = buf.readUInt16LE(8);
		var ephemeral = Buffer.alloc(ephemeralLength);
		buf.copy(ephemeral, 0, 10, 10 + ephemeralLength);

		return {
			session: buf.readUInt32LE(4),
			ephemeral: ephemeral
		};
	}
};

// Auth server ephemeral
// UInt32, UInt16, Buffer
var authEphemeral = {
	marshall: function(data) {
		var buf = Buffer.alloc(10 + data.ephemeral.length);

		buf.writeUInt32LE(AUTH_EPHEMERAL, 0);
		buf.writeUInt32LE(data.session, 4);
		buf.writeUInt16LE(data.ephemeral.length, 8);
		data.ephemeral.copy(buf, 10);

		return buf;
	},
	unmarshall: function(buf) {
		if (buf.readUInt32LE(0) !== AUTH_EPHEMERAL) {
			throw new TypeError("Buffer is not an AUTH_EPHEMERAL packet");
		}

		var ephemeralLength = buf.readUInt16LE(8);
		var ephemeral = Buffer.alloc(ephemeralLength);
		buf.copy(ephemeral, 0, 10, 10 + ephemeralLength);

		return {
			session: buf.readUInt32LE(4),
			ephemeral: ephemeral
		};
	}
};

// Server Proof
// UInt32, UInt16, Buffer
var serverProof = {
	marshall: function(data) {
		var buf = Buffer.alloc(10 + data.proof.length);

		buf.writeUInt32LE(SERVER_PROOF, 0);
		buf.writeUInt32LE(data.session, 4);
		buf.writeUInt16LE(data.proof.length, 8);
		data.proof.copy(buf, 10);

		return buf;
	},
	unmarshall: function(buf) {
		if (buf.readUInt32LE(0) !== SERVER_PROOF) {
			throw new TypeError("Buffer is not an SERVER_PROOF packet");
		}

		var proofLength = buf.readUInt16LE(8);
		var proof = Buffer.alloc(proofLength);
		buf.copy(proof, 0, 10, 10 + proofLength);

		return {
			session: buf.readUInt32LE(4),
			proof: proof
		};
	}
};

// Auth server Proof
// UInt32, UInt16, Buffer
var authProof = {
	marshall: function(data) {
		var buf = Buffer.alloc(10 + data.proof.length);

		buf.writeUInt32LE(AUTH_PROOF, 0);
		buf.writeUInt32LE(data.session, 4);
		buf.writeUInt16LE(data.proof.length, 8);
		data.proof.copy(buf, 10);

		return buf;
	},
	unmarshall: function(buf) {
		if (buf.readUInt32LE(0) !== AUTH_PROOF) {
			throw new TypeError("Buffer is not an AUTH_PROOF packet");
		}

		var proofLength = buf.readInt16LE(8);
		var proof = Buffer.alloc(proofLength);
		buf.copy(proof, 0, 10, 10 + proofLength);

		return {
			session: buf.readUInt32LE(4),
			proof: proof
		};
	}
};

// Errors
var userError = {
	marshall: function(data) {
		var buf = Buffer.alloc(5 + Buffer.byteLength(data.username, 'ascii') + 1);

		buf.writeUInt32LE(ERROR_USER, 0);
		buf.writeUInt8(data.error, 4);
		writeString(buf, data.username, 5, 'ascii');

		return buf;
	},
	unmarshall: function(buf) {
		if (buf.readUInt32LE(0) !== ERROR_USER) {
			throw new TypeError("Buffer is not an ERROR_USER packet");
		}

		return {
			error: buf.readUInt8(4),
			username: readString(buf, 5, 'ascii')
		};
	}
};

var clientSessionError = {
	marshall: function(data) {
		var buf = Buffer.alloc(9);

		buf.writeUInt32LE(ERROR_CLIENTSESSION, 0);
		buf.writeUInt8(data.error, 4);
		buf.writeUInt32LE(data.clientSession, 5);

		return buf;
	},
	unmarshall: function(buf) {
		if (buf.readUInt32LE(0) !== ERROR_CLIENTSESSION) {
			throw new TypeError("Buffer is not an ERROR_SESSION packet");
		}

		return {
			clientSession: buf.readUInt32LE(5),
			error: buf.readUInt8(4)
		};
	}
};

var sessionError = {
	marshall: function(data) {
		var buf = Buffer.alloc(9);

		buf.writeUInt32LE(ERROR_SESSION, 0);
		buf.writeUInt8(data.error, 4);
		buf.writeUInt32LE(data.session, 5);

		return buf;
	},
	unmarshall: function(buf) {
		if (buf.readUInt32LE(0) !== ERROR_SESSION) {
			throw new TypeError("Buffer is not an ERROR_SESSION packet");
		}

		return {
			error: buf.readUInt8(4),
			session: buf.readUInt32LE(5)
		};
	}
};

exports.serverNegotiate = serverNegotiate;
exports.authNegotiate = authNegotiate;
exports.serverEphemeral = serverEphemeral;
exports.authEphemeral = authEphemeral;
exports.serverProof = serverProof;
exports.authProof = authProof;

exports.userError = userError;
exports.clientSessionError = clientSessionError;
exports.sessionError = sessionError;

exports.SERVER_NEGOTIATE = SERVER_NEGOTIATE;
exports.AUTH_NEGOTIATE = AUTH_NEGOTIATE;
exports.SERVER_EPHEMERAL = SERVER_EPHEMERAL;
exports.AUTH_EPHEMERAL = AUTH_EPHEMERAL;
exports.SERVER_PROOF = SERVER_PROOF;
exports.AUTH_PROOF = AUTH_PROOF;

exports.ERROR_USER = ERROR_USER;
exports.ERROR_CLIENTSESSION = ERROR_CLIENTSESSION;
exports.ERROR_SESSION = ERROR_SESSION;

exports.USER_TRY_LATER = 0;
exports.USER_NO_EXIST = 1;
exports.USER_OUTDATED_PROTOCOL = 2;
exports.USER_WILL_NOT_AUTH = 3;

exports.SESSION_TRY_LATER = 0;
exports.SESSION_NO_EXIST = 1;
exports.SESSION_VERIFIER_UNSAFE = 2;
exports.SESSION_AUTH_FAILED = 3;
