import { logger } from '@dydxprotocol-indexer/base';
import {
  OrderFromDatabase,
  OrderStatus,
  OrderTable,
  PerpetualMarketFromDatabase,
  perpetualMarketRefresher,
  protocolTranslations, SubaccountFromDatabase,
  SubaccountMessageContents,
} from '@dydxprotocol-indexer/postgres';
import {
  IndexerOrder,
  IndexerSubaccountId,
  StatefulOrderEventV1,
} from '@dydxprotocol-indexer/v4-protos';

import config from '../../config';
import { generateOrderSubaccountMessage } from '../../helpers/kafka-helper';
import { getTriggerPrice } from '../../lib/helper';
import { ConsolidatedKafkaEvent } from '../../lib/types';
import { AbstractStatefulOrderHandler } from '../abstract-stateful-order-handler';

export class ConditionalOrderPlacementHandler extends
  AbstractStatefulOrderHandler<StatefulOrderEventV1> {
  eventType: string = 'StatefulOrderEvent';

  public getParallelizationIds(): string[] {
    const orderId: string = OrderTable.orderIdToUuid(
      this.event.conditionalOrderPlacement!.order!.orderId!,
    );
    return this.getParallelizationIdsFromOrderId(orderId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async internalHandle(): Promise<ConsolidatedKafkaEvent[]> {
    if (config.USE_STATEFUL_ORDER_HANDLER_SQL_FUNCTION) {
      return this.handleViaSqlFunction();
    }
    return this.handleViaKnex();
  }

  private async handleViaSqlFunction(): Promise<ConsolidatedKafkaEvent[]> {
    const result:
    [OrderFromDatabase,
      PerpetualMarketFromDatabase,
      SubaccountFromDatabase | undefined] = await this.handleEventViaSqlFunction();

    const subaccountId:
    IndexerSubaccountId = this.event.conditionalOrderPlacement!.order!.orderId!.subaccountId!;
    return this.createKafkaEvents(subaccountId, result[0], result[1]);
  }

  private async handleViaKnex(): Promise<ConsolidatedKafkaEvent[]> {
    const order: IndexerOrder = this.event.conditionalOrderPlacement!.order!;
    const subaccountId: IndexerSubaccountId = order.orderId!.subaccountId!;
    const clobPairId: string = order.orderId!.clobPairId.toString();
    const perpetualMarket: PerpetualMarketFromDatabase | undefined = perpetualMarketRefresher
      .getPerpetualMarketFromClobPairId(clobPairId);
    if (perpetualMarket === undefined) {
      logger.error({
        at: 'conditionalOrderPlacementHandler#internalHandle',
        message: 'Unable to find perpetual market',
        clobPairId,
        order,
      });
      throw new Error(`Unable to find perpetual market with clobPairId: ${clobPairId}`);
    }

    const conditionalOrder: OrderFromDatabase = await this.runFuncWithTimingStatAndErrorLogging(
      this.upsertOrder(
        perpetualMarket!,
        order,
        protocolTranslations.protocolConditionTypeToOrderType(order.conditionType),
        OrderStatus.UNTRIGGERED,
        getTriggerPrice(order, perpetualMarket),
      ),
      this.generateTimingStatsOptions('upsert_order'),
    );

    return this.createKafkaEvents(subaccountId, conditionalOrder, perpetualMarket);
  }

  private createKafkaEvents(
    subaccountId: IndexerSubaccountId,
    conditionalOrder: OrderFromDatabase,
    perpetualMarket: PerpetualMarketFromDatabase): ConsolidatedKafkaEvent[] {

    // Since the order isn't placed on the book, no message is sent to vulcan
    // ender needs to send the websocket message indicating the conditional order was placed
    const message: SubaccountMessageContents = {
      orders: [
        generateOrderSubaccountMessage(conditionalOrder, perpetualMarket.ticker),
      ],
    };

    return [
      this.generateConsolidatedSubaccountKafkaEvent(
        JSON.stringify(message),
        subaccountId,
      ),
    ];
  }
}
