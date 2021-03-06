import {Base} from "./base";
import {createHash, randomBytes} from "node/crypto";
import {Extensions} from "./extensions";
import {Frame} from "./hybi/frame";
import {Message} from "./hybi/message";


export class Hybi extends Base {
    static GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

    static mask(payload, mask, offset?) {
        if (!mask || mask.length === 0) return payload;
        offset = offset || 0;

        for (let i = 0, n = payload.length - offset; i < n; i++) {
            payload[offset + i] = payload[offset + i] ^ mask[i % 4];
        }
        return payload;
    }

    static generateAccept(key) {
        let sha1 = createHash('sha1');
        sha1.update(key + Hybi.GUID);
        return sha1.digest('base64');
    }

    //
    FIN = 0x80;
    MASK = 0x80;
    RSV1 = 0x40;
    RSV2 = 0x20;
    RSV3 = 0x10;
    OPCODE = 0x0F;
    LENGTH = 0x7F;
    OPCODES = {
        continuation: 0,
        text: 1,
        binary: 2,
        close: 8,
        ping: 9,
        pong: 10
    };
    OPCODE_CODES = [0, 1, 2, 8, 9, 10];
    MESSAGE_OPCODES = [0, 1, 2];
    OPENING_OPCODES = [1, 2];
    ERRORS = {
        normal_closure: 1000,
        going_away: 1001,
        protocol_error: 1002,
        unacceptable: 1003,
        encoding_error: 1007,
        policy_violation: 1008,
        too_large: 1009,
        extension_error: 1010,
        unexpected_condition: 1011
    };
    ERROR_CODES = [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011];
    DEFAULT_ERROR_CODE = 1000;
    MIN_RESERVED_ERROR = 3000;
    MAX_RESERVED_ERROR = 4999;
    UTF8_MATCH = /^([\x00-\x7F]|[\xC2-\xDF][\x80-\xBF]|\xE0[\xA0-\xBF][\x80-\xBF]|[\xE1-\xEC\xEE\xEF][\x80-\xBF]{2}|\xED[\x80-\x9F][\x80-\xBF]|\xF0[\x90-\xBF][\x80-\xBF]{2}|[\xF1-\xF3][\x80-\xBF]{3}|\xF4[\x80-\x8F][\x80-\xBF]{2})*$/;
    //
    public key:string;
    public protocol:string;
    public version:string;

    protected _extensions:Extensions;
    protected _masking:any;
    protected _protocols:string[];
    protected _requireMasking:any;
    protected _pingCallbacks:any;
    protected _frame:Frame;
    protected _message:Message;

    constructor(request, url, options) {
        super(request, url, options);
        this._extensions = new Extensions();
        this._stage = 0;
        this._masking = this._options.masking;
        this._requireMasking = this._options.requireMasking;
        this._pingCallbacks = {};

        if (typeof this._options.protocols === 'string') {
            this._protocols = this._options.protocols.split(/\s*,\s*/);
        } else {
            this._protocols = this._options.protocols || [];
        }


        if (!this._request) return;

        let secKey = this._request.headers['sec-websocket-key'],
            protos = this._request.headers['sec-websocket-protocol'],
            version = this._request.headers['sec-websocket-version'],
            supported = this._protocols;
        this.key = secKey;
        this._headers.set('Upgrade', 'websocket');
        this._headers.set('Connection', 'Upgrade');
        this._headers.set('Sec-WebSocket-Accept', Hybi.generateAccept(secKey));

        if (protos !== undefined) {
            if (typeof protos === 'string') {
                protos = protos.split(/\s*,\s*/);
            }
            this.protocol = protos.filter(function (p) {
                return supported.indexOf(p) >= 0
            })[0];
            if (this.protocol) {
                this._headers.set('Sec-WebSocket-Protocol', this.protocol);
            }
        }

        this.version = 'hybi-' + version;
    }

    public addExtension(extension) {
        this._extensions.add(extension);
        return true;
    }

    public parse(chunk) {
        //console.info("<<<", createHash('md5').update(chunk).digest("hex"), chunk);
        this._reader.put(chunk);
        let buffer = true;
        while (buffer) {
            switch (this._stage) {
                case 0:
                    buffer = this._reader.read(1);
                    if (buffer){
                        this._parseOpcode(buffer[0]);
                    }
                    break;
                case 1:
                    buffer = this._reader.read(1);
                    if (buffer){
                        this._parseLength(buffer[0]);
                    }
                    break;
                case 2:
                    buffer = this._reader.read(this._frame.lengthBytes);
                    if (buffer){
                        this._parseExtendedLength(buffer);
                    }
                    break;
                case 3:
                    buffer = this._reader.read(4);
                    if (buffer) {
                        this._stage = 4;
                        this._frame.maskingKey = buffer;
                    }
                    break;
                case 4:
                    buffer = this._reader.read(this._frame.length);
                    if (buffer) {
                        this._stage = 0;
                        this._emitFrame(buffer);
                    }
                    break;
                default:
                    buffer = null;
            }
        }
    }
    public text(message):boolean {
        if (this.readyState > 1){
            return false;
        }
        return this.frame(message, 'text');
    }
    public binary(message):boolean {
        if (this.readyState > 1){
            return false;
        }
        return this.frame(message, 'binary');
    }
    public ping(message, callback?):boolean {
        if (this.readyState > 1){
            return false;
        }
        message = message || '';
        if (callback){
            this._pingCallbacks[message] = callback;
        }
        return this.frame(message, 'ping');
    }
    public pong(message):boolean{
        if (this.readyState > 1){
            return false;
        }
        message = message || '';
        return this.frame(message, 'pong');
    }
    public close(reason?, code?):boolean{
        reason = reason || '';
        code = code || this.ERRORS.normal_closure;

        if (this.readyState <= 0) {
            this.readyState = 3;
            this.emit('close', new Base.CloseEvent(code, reason));
            return true;
        } else if (this.readyState === 1) {
            this.readyState = 2;
            this._extensions.close(function () {
                this.frame(reason, 'close', code)
            }, this);
            return true;
        } else {
            return false;
        }
    }
    public frame(buffer, type?, code?) {
        if (this.readyState <= 0) return this._queue([buffer, type, code]);
        if (this.readyState > 2) return false;

        if (Array.isArray(buffer)) buffer = new Buffer(buffer);
        if (typeof buffer === 'number'){
            buffer = buffer.toString();
        }

        let message = new Message(),
            isText = (typeof buffer === 'string'),
            payload, copy;

        message.rsv1 = message.rsv2 = message.rsv3 = false;
        message.opcode = this.OPCODES[type || (isText ? 'text' : 'binary')];

        payload = isText ? new Buffer(buffer, 'utf8') : buffer;

        if (code) {
            copy = payload;
            payload = new Buffer(2 + copy.length);
            payload.writeUInt16BE(code, 0);
            copy.copy(payload, 2);
        }
        message.data = payload;

        let onMessageReady = (message)=> {
            let frame = new Frame();

            frame.final = true;
            frame.rsv1 = message.rsv1;
            frame.rsv2 = message.rsv2;
            frame.rsv3 = message.rsv3;
            frame.opcode = message.opcode;
            frame.masked = !!this._masking;
            frame.length = message.data.length;
            frame.payload = message.data;

            if (frame.masked) {
                frame.maskingKey = randomBytes(4);
            }

            this._sendFrame(frame);
        };

        if (this.MESSAGE_OPCODES.indexOf(message.opcode) >= 0){
            //onMessageReady(message);
            this._extensions.processOutgoingMessage(message, function (error, message) {
                if (error) {
                    return this._fail('extension_error', error.message);
                }
                onMessageReady(message);
            }, this);
        } else {
            onMessageReady(message);
        }
        return true;
    }

    protected _sendFrame(frame) {
        let length = frame.length,
            header = (length <= 125) ? 2 : (length <= 65535 ? 4 : 10),
            offset = header + (frame.masked ? 4 : 0),
            buffer = new Buffer(offset + length),
            masked = frame.masked ? this.MASK : 0;

        buffer[0] = (frame.final ? this.FIN : 0) |
            (frame.rsv1 ? this.RSV1 : 0) |
            (frame.rsv2 ? this.RSV2 : 0) |
            (frame.rsv3 ? this.RSV3 : 0) |
            frame.opcode;

        if (length <= 125) {
            buffer[1] = masked | length;
        } else if (length <= 65535) {
            buffer[1] = masked | 126;
            buffer.writeUInt16BE(length, 2);
        } else {
            buffer[1] = masked | 127;
            buffer.writeUInt32BE(Math.floor(length / 0x100000000), 2);
            buffer.writeUInt32BE(length % 0x100000000, 6);
        }

        frame.payload.copy(buffer, offset);

        if (frame.masked) {
            frame.maskingKey.copy(buffer, header);
            Hybi.mask(buffer, frame.maskingKey, offset);
        }
        //console.info(">>>", createHash('md5').update(buffer).digest("hex"), buffer);
        this._write(buffer);
    }
    protected _handshakeResponse():any {
        let extensions;
        try {
             extensions = this._extensions.generateResponse(
                 this._request.headers['sec-websocket-extensions']
             );
        } catch (e) {
            return this._fail('protocol_error', e.message);
        }
        if (extensions){
            this._headers.set('Sec-WebSocket-Extensions', extensions);
        }
        let start = 'HTTP/1.1 101 Switching Protocols';
        let headers = [start, this._headers.toString(), ''];
        return new Buffer(headers.join('\r\n'), 'utf8');
    }
    protected _shutdown(code, reason, error?) {
        delete this._frame;
        delete this._message;
        this._stage = 5;

        let sendCloseFrame = (this.readyState === 1);
        this.readyState = 2;

        this._extensions.close(function () {
            if (sendCloseFrame) this.frame(reason, 'close', code);
            this.readyState = 3;
            if (error) this.emit('error', new Error(reason));
            this.emit('close', new Base.CloseEvent(code, reason));
        }, this);
    }
    protected _fail(type, message) {
        if (this.readyState > 1) return;
        this._shutdown(this.ERRORS[type], message, true);
    }
    protected _parseOpcode(octet) {
        let rsvs = [this.RSV1, this.RSV2, this.RSV3].map(function (rsv) {
            return (octet & rsv) === rsv;
        });

        let frame = this._frame = new Frame();

        frame.final = (octet & this.FIN) === this.FIN;
        frame.rsv1 = rsvs[0];
        frame.rsv2 = rsvs[1];
        frame.rsv3 = rsvs[2];
        frame.opcode = (octet & this.OPCODE);

        this._stage = 1;

        if (!this._extensions.validFrameRsv(frame))
            return this._fail('protocol_error',
                'One or more reserved bits are on: reserved1 = ' + (frame.rsv1 ? 1 : 0) +
                ', reserved2 = ' + (frame.rsv2 ? 1 : 0) +
                ', reserved3 = ' + (frame.rsv3 ? 1 : 0));

        if (this.OPCODE_CODES.indexOf(frame.opcode) < 0)
            return this._fail('protocol_error', 'Unrecognized frame opcode: ' + frame.opcode);

        if (this.MESSAGE_OPCODES.indexOf(frame.opcode) < 0 && !frame.final)
            return this._fail('protocol_error', 'Received fragmented control frame: opcode = ' + frame.opcode);

        if (this._message && this.OPENING_OPCODES.indexOf(frame.opcode) >= 0)
            return this._fail('protocol_error', 'Received new data frame but previous continuous frame is unfinished');
    }
    protected _parseLength(octet) {
        let frame = this._frame;
        frame.masked = (octet & this.MASK) === this.MASK;
        frame.length = (octet & this.LENGTH);

        if (frame.length >= 0 && frame.length <= 125) {
            this._stage = frame.masked ? 3 : 4;
            if (!this._checkFrameLength()) return;
        } else {
            this._stage = 2;
            frame.lengthBytes = (frame.length === 126 ? 2 : 8);
        }

        if (this._requireMasking && !frame.masked)
            return this._fail('unacceptable', 'Received unmasked frame but masking is required');
    }
    protected _parseExtendedLength(buffer) {
        let frame = this._frame;
        frame.length = this._readUInt(buffer);

        this._stage = frame.masked ? 3 : 4;

        if (this.MESSAGE_OPCODES.indexOf(frame.opcode) < 0 && frame.length > 125)
            return this._fail('protocol_error', 'Received control frame having too long payload: ' + frame.length);

        if (!this._checkFrameLength()) return;
    }
    protected _checkFrameLength() {
        let length = this._message ? this._message.length : 0;

        if (length + this._frame.length > this._maxLength) {
            this._fail('too_large', 'WebSocket frame length too large');
            return false;
        } else {
            return true;
        }
    }
    protected _emitFrame(buffer) {
        let frame = this._frame,
            payload = frame.payload = Hybi.mask(buffer, frame.maskingKey),
            opcode = frame.opcode,
            message,
            code, reason,
            callbacks, callback;

        delete this._frame;

        if (opcode === this.OPCODES.continuation) {
            if (!this._message) return this._fail('protocol_error', 'Received unexpected continuation frame');
            this._message.pushFrame(frame);
        }

        if (opcode === this.OPCODES.text || opcode === this.OPCODES.binary) {
            this._message = new Message();
            this._message.pushFrame(frame);
        }

        if (frame.final && this.MESSAGE_OPCODES.indexOf(opcode) >= 0)
            return this._emitMessage(this._message);

        if (opcode === this.OPCODES.close) {
            code = (payload.length >= 2) ? payload.readUInt16BE(0) : null;
            reason = (payload.length > 2) ? this._encode(payload.slice(2)) : null;

            if (!(payload.length === 0) && !(code !== null && code >= this.MIN_RESERVED_ERROR && code <= this.MAX_RESERVED_ERROR) &&
                this.ERROR_CODES.indexOf(code) < 0)
                code = this.ERRORS.protocol_error;

            if (payload.length > 125 || (payload.length > 2 && !reason))
                code = this.ERRORS.protocol_error;

            this._shutdown(code || this.DEFAULT_ERROR_CODE, reason || '');
        }

        if (opcode === this.OPCODES.ping) {
            this.frame(payload, 'pong');
        }

        if (opcode === this.OPCODES.pong) {
            callbacks = this._pingCallbacks;
            message = this._encode(payload);
            callback = callbacks[message];

            delete callbacks[message];
            if (callback) callback()
        }
    }
    protected _emitMessage(message) {
        message = this._message;
        message.read();
        delete this._message;
        this._extensions.processIncomingMessage(message, function (error, message) {
            if (error){
                return this._fail('extension_error', error.message);
            }
            let payload = message.data;
            if (message.opcode === this.OPCODES.text) payload = this._encode(payload);
            if (payload === null)
                return this._fail('encoding_error', 'Could not decode a text frame as UTF-8');
            else
                this.emit('message', new Base.MessageEvent(payload));
        }, this);
    }
    protected _encode(buffer) {
        try {
            let string = buffer.toString('binary', 0, buffer.length);
            if (!this.UTF8_MATCH.test(string)) return null;
        } catch (e) {
        }
        return buffer.toString('utf8', 0, buffer.length);
    }
    protected _readUInt(buffer) {
        if (buffer.length === 2) return buffer.readUInt16BE(0);

        return buffer.readUInt32BE(0) * 0x100000000 +
            buffer.readUInt32BE(4);
    }
}
