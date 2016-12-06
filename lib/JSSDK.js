const debug = require('debug')('wechat');
const Promise = require('bluebird');
const _ = require('lodash');
const urlParser = require('url');

const util = require('./utils');
const config = require('./config');

const Store = require('./store/Store');
const FileStore = require('./store/FileStore');

const wxConfig = config.getDefaultConfiguration();

//1h 59m, token is only valid within 2 hours
const REFRESH_INTERVAL = 1000 * 119 * 60;

class JSSDK {

  /**
   * Pass custom wechat config for the instance
   * @constructor
   * @param {object=} options
   * @see ./config.js
   * @return {JSSDK} JSSDK instance
   */
  constructor (options) {

    config.checkPassedConfiguration(options);
    this.refreshedTimes = 0;
    this.wechatConfig = _.isEmpty(options) ? wxConfig : Object.assign({}, wxConfig, options);

    //no custom store provided, using default FileStore
    if(!options.store || !(options.store instanceof Store)) {
      debug('Store not provided, using default FileStore...');
      this.store = new FileStore();
    } else {
      this.store = options.store;
    }

    //clear the counter every 2 hour
    setInterval(() => this.refreshedTimes = 0, 1000 * 7200);
  }

  /**
   * Check if token is expired starting from the modify date
   * @param modifyDate
   * @static
   * @return {boolean}
   */
  static isTokenExpired (modifyDate) {
    return Date.now() - new Date(modifyDate).getTime() > REFRESH_INTERVAL;
  }

  /**
   * Create NonceStr before generating the signature
   * @static
   * @return {string}
   */
  static createNonceStr () {
    return Math.random().toString(36).substr(2, 15);
  }

  /**
   * Filter the signature for the client
   * @param {object} reply original signature information
   * @static
   * @return {object} filtered signature object
   */
  static signatureResult (reply) {
    if(!reply) {
      return {};
    }
    return {
      timestamp: reply.timestamp,
      nonceStr: reply.nonceStr,
      signature: reply.signature,
      url: reply.url,
    };
  }

  /**
   * Remove hash from the url, wechat signature does not need it
   * @param {string} url original url
   * @static
   * @return {string}
   */
  static normalizeUrl (url) {
    const temp = urlParser.parse(url);
    const hashIndex = url.indexOf(temp.hash);
    //remove hash from url
    return hashIndex > 0 ? url.substring(0, hashIndex) : url;
  }


  /**
   * Need to verify before you are a wechat developer
   * @param {object} query url query sent by the wechat server to do the validation
   * @return {boolean}
   */
  verifySignature (query) {
    const keys = [this.wechatConfig.wechatToken, query['timestamp'], query['nonce']];
    let str = keys.sort().join('');
    str = util.genSHA1(str);
    return str === query.signature;
  }

  /**
   * Send request to get wechat access token
   * @return {Promise}
   */
  getAccessToken () {
    const params = {
      grant_type: 'client_credential',
      appid: this.wechatConfig.appId,
      secret: this.wechatConfig.appSecret,
    };
    return util.sendWechatRequest({
        url: this.wechatConfig.accessTokenUrl,
        baseUrl: '',
        qs: params,
      })
      .then(data => data)
      .catch((reason) => {
        debug('get wechat access token failed!');
        return Promise.reject(reason);
      });
  }

  /**
   * Get wechat ticket with the accessToken
   * @param {string} accessToken token received from the @see getAccessToken above
   * @return {Promise}
   */
  getWechatTicket (accessToken) {
    const params = {
      access_token: accessToken,
      type: 'jsapi',
    };
    return util.sendWechatRequest({
        url: this.wechatConfig.ticketUrl,
        baseUrl: '',
        qs: params,
      })
      .then(data => data)
      .catch((reason) => {
        debug('get ticket failed!');
        return Promise.reject(reason);
      });
  }

  /**
   * Update the global token or js_ticket, we should cache this to prevent requesting too often
   * @param {string} token
   * @param {string} ticket
   * @return {Promise} resolved with the updated globalToken object
   */
  updateAccessTokenOrTicketGlobally (token, ticket) {
    const info = {modifyDate: new Date};
    token && (info.accessToken = token);
    ticket && (info.jsapi_ticket = ticket);
    return this.store.updateGlobalTokenInfo(info);
  }

  /**
   * Get new access token and ticket from wechat server, and update that to cache
   * @param {boolean=} force force update, by default it will only get at most 5 times within 2 hours,
   *        cause the wechat server limits the access_token requests number
   * @return {Promise}
   */
  getNewTokenAndTicket (force) {
    //temp way to prevent refresh too often
    force || this.refreshedTimes++;
    if(!force && this.refreshedTimes > 5) {
      return Promise.reject(new Error('maximum manual refresh threshold reached!'));
    }
    let accessToken = '';
    return this.getAccessToken()
      .then((result) => {
        accessToken = result.access_token;
        return accessToken;
      })
      .catch((reason) => {
        debug('get new global token failed!');
        return Promise.reject(reason);
      })
      .then((receivedAccessToken) => {
        return this.getWechatTicket(receivedAccessToken);
      })
      .then((ticketResult) => {
        return this.updateAccessTokenOrTicketGlobally(accessToken, ticketResult.ticket);
      })
      .catch((ticketReason) => {
        debug('get new global ticket failed!');
        debug(ticketReason);
        return Promise.reject(ticketReason);
      });
  }

  /**
   * Get or generate global token info for signature generating process
   * @return {Promise}
   */
  prepareNewSignature () {
    return this.store.getGlobalTokenInfo()
      .then((globalToken) => {
        if(!globalToken || !globalToken.accessToken || JSSDK.isTokenExpired(globalToken.modifyDate)) {
          debug('global access token was expired, getting new global ticket now...');
          return this.getNewTokenAndTicket(true);
        }
        debug('global ticket exists, use cached access token');
        return Promise.resolve(globalToken);
      });
  }

  /**
   * Generate the url signature with the provided info
   * @param {string} ticket js ticket
   * @param {string} url current url
   * @param {string} accessToken
   * @returns {object} generated wechat signature info
   */
  genSignature (ticket, url, accessToken) {
    const ret = {
      jsapi_ticket: ticket,
      nonceStr: JSSDK.createNonceStr(),
      timestamp: parseInt(new Date().getTime() / 1000) + '',
      url: JSSDK.normalizeUrl(url),
    };
    const originalStr = util.paramsToString(ret);
    ret.signature = util.genSHA1(originalStr);
    ret.accessToken = accessToken;
    return ret;
  }

  /**
   * Save or update the signature
   * @param {object} info signature information to save
   * @return {Promise}
   */
  saveNewSignature (info) {
    const signature = Object.assign({}, info);
    signature.createDate = new Date;
    signature.modifyDate = signature.createDate;
    return this.store.isSignatureExisted(signature.url)
      .then((existing) => {
        if(existing) {
          debug('wechat url signature existed, try updating the signature...');
          return this.updateSignatureByUrl(signature.url, signature);
        }
        return this.store.setNewSignature(signature.signatureName, signature);
      })
      .then((sig) => {
        debug('create/update wechat signature finished');
        return Promise.resolve(sig);
      });
  }

  /**
   * Update the signature for existing url
   * @param {string} url signature of url need to update
   * @param {object} info update info need to be updated to the existing url signature info
   * @return {Promise}
   */
  updateSignatureByUrl (url, info) {
    url = JSSDK.normalizeUrl(url);
    info.modifyDate = new Date;
    delete info.url; //prevent changing the original url
    delete info.signatureName; //prevent changing the original name
    return this.store.updateSignature(url, info)
      .then((sig) => {
        debug('update wechat signature finished');
        return Promise.resolve(sig);
      });
  }

  /**
   * Get the signature from cache or create a new one
   * @param {string} url
   * @param {boolean=} forceNewSignature if true, generate a new signature rather than getting from cache
   * @return {Promise}
   */
  getSignatureByURL (url, forceNewSignature) {
    url = JSSDK.normalizeUrl(url);
    return this.store.getCachedSignatureByUrl(url)
      .then((signature) => {
        if(!forceNewSignature && signature && !JSSDK.isTokenExpired(signature.modifyDate)) {
          signature = JSSDK.signatureResult(signature);
          return Promise.resolve(signature);
        }
        return this.createNewSignature(url);
      })
      ;
  }

  /**
   * Create a new signature now
   * @param {string} url signature will be created for the url
   * @return {Promise}
   */
  createNewSignature (url) {
    return this.prepareNewSignature()
      .then((data) => {
        const ret = this.genSignature(data.jsapi_ticket, url, data.accessToken);
        ret.signatureName = ret.url;
        return this.saveNewSignature(ret);
      })
      .then(sig => JSSDK.signatureResult(sig))
      ;
  }

  /**
   * Just get url signature from cache
   * @param {string} url
   * @return {Promise} filtered signature info
   */
  getCachedUrlSignature (url) {
    url = JSSDK.normalizeUrl(url);
    return this.store.getCachedSignatureByUrl(url)
      .then((signature) => {
        return Promise.resolve(JSSDK.signatureResult(signature));
      });
  }

  /**
   * Get the whole cached token object
   * @return {Promise}
   */
  getStore () {
    return Promise.resolve(this.store);
  }

  /**
   * Only get the global token info from cache
   * @return {Promise}
   */
  getCachedGlobalToken () {
    return this.store.getGlobalTokenInfo();
  }

}

module.exports = JSSDK;