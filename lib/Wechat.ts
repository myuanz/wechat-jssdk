import debugFnc from 'debug';
import deepmerge from 'deepmerge';
import { isPlainObject } from 'is-plain-object';

import JSSDK from './JSSDK';
import OAuth from './OAuth';
import Card from './Card';
import Payment from './Payment';
import MiniProgram from './MiniProgram';
import Store from './store/Store';
import FileStore from './store/FileStore';
import { WeChatOptions } from './WeChatOptions';
import { getDefaultConfiguration } from './config';

const debug = debugFnc('wechat');

const wxConfig = getDefaultConfiguration();

class Wechat {
  jssdk!: JSSDK;
  oauth!: OAuth;
  card!: Card;
  payment!: Payment;
  store!: Store;
  miniProgram!: MiniProgram;
  /**
   * @constructor
   * @param oldOptions custom wechat configuration
   * @return {Wechat}
   */
  constructor(oldOptions: WeChatOptions) {
    const options: WeChatOptions = deepmerge(wxConfig, oldOptions, {
      isMergeableObject: isPlainObject,
    });

    //no custom store provided, using default FileStore
    if (!options.store || !(options.store instanceof Store)) {
      debug('Store not provided, using default FileStore...');
      options.store = new FileStore(options);
    }

    //create a JSSDK instance
    this.jssdk = new JSSDK(options);
    //create a OAuth instance
    this.oauth = new OAuth(options);
    /* istanbul ignore if  */
    if (oldOptions.card) {
      //create a Card instance
      this.card = new Card(options);
    }
    /* istanbul ignore if  */
    if (oldOptions.payment) {
      //create a Payment instance
      this.payment = new Payment(options);
    }
    /* istanbul ignore if  */
    if (oldOptions.miniProgram) {
      //create a MiniProgram instance
      this.miniProgram = new MiniProgram(options);
    }

    this.store = options.store;
  }
}

export default Wechat;
