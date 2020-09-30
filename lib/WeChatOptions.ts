import { WeChatConfig } from './config';
import Store from './store/Store';
import Card from './Card';
import { StoreOptions } from './store/StoreOptions';

export interface WeChatOptions<StoreOptionsType = StoreOptions>
  extends WeChatConfig {
  store?: Store;
  storeOptions?: StoreOptionsType;
  clearCountInterval?: number;
  card?: boolean | Card;
}
