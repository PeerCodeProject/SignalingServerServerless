import { ApiGatewayManagementApi, AWSError, DynamoDB } from "aws-sdk";
import { PromiseResult } from "aws-sdk/lib/request";

const { AWS_REGION, TOPICS_TABLE } = process.env;

const dynamoDb = new DynamoDB({
  apiVersion: "2012-08-10",
  region: AWS_REGION,
});

export async function* scanItems(
  dynamoDb: DynamoDB,
  tableName: string,
  extraScanInput?: Omit<DynamoDB.ScanInput, "TableName" | "ExclusiveStartKey">
): AsyncGenerator<DynamoDB.AttributeMap, void, unknown> {
  let startKey: DynamoDB.Key | undefined;
  do {
    const result = await dynamoDb
      .scan({
        TableName: tableName,
        ExclusiveStartKey: startKey,
        ...extraScanInput,
      })
      .promise();
    for (const item of result.Items || []) {
      yield item;
    }
    startKey = result.LastEvaluatedKey;
  } while (startKey);
}

// Message structure and protocol flow taken from y-webrtc/bin/server.js
interface YWebRtcSubscriptionMessage {
  type: "subscribe" | "unsubscribe";
  topics?: string[];
}
interface YWebRtcPingMessage {
  type: "ping";
}
interface YWebRtcPublishMessage {
  type: "publish";
  topic?: string;
  [k: string]: any;
}

async function subscribe(topic: string, connectionId: string) {
  return dynamoDb
    .updateItem({
      TableName: TOPICS_TABLE,
      Key: { name: { S: topic } },
      UpdateExpression: "ADD receivers :r",
      ExpressionAttributeValues: {
        ":r": { SS: [connectionId] },
      },
    })
    .promise()
    .catch((err) => {
      console.log(`Cannot update topic ${topic}: ${err.message}`);
    });
}

async function unsubscribe(topic: string, connectionId: string) {
  return dynamoDb
    .updateItem({
      TableName: TOPICS_TABLE,
      Key: { name: { S: topic } },
      UpdateExpression: "DELETE receivers :r",
      ExpressionAttributeValues: {
        ":r": { SS: [connectionId] },
      },
    })
    .promise()
    .catch((err) => {
      console.log(`Cannot update topic ${topic}: ${err.message}`);
    });
}

async function getReceivers(topic: string) {
  try {
    const { Item: item } = await dynamoDb
      .getItem({
        TableName: TOPICS_TABLE,
        Key: { name: { S: topic } },
      })
      .promise();
    return item?.receivers ? item.receivers.SS : [];
  } catch (err) {
    console.log(`Cannot get topic ${topic}: ${err.message}`);
    return [];
  }
}

async function handleYWebRtcMessage(
  connectionId: string,
  message:
    | YWebRtcSubscriptionMessage
    | YWebRtcPublishMessage
    | YWebRtcPingMessage,
  send: (receiver: string, message: any) => Promise<void>
) {
  const promises: Array<Promise<void | PromiseResult<DynamoDB.UpdateItemOutput, AWSError>>> = [];

  if (message && message.type) {
    switch (message.type) {
      case "subscribe":
        (message.topics || []).forEach((topic) => {
          promises.push(subscribe(topic, connectionId));
        });
        break;
      case "unsubscribe":
        (message.topics || []).forEach((topic) => {
          promises.push(unsubscribe(topic, connectionId));
        });
        break;
      case "publish":
        if (message.topic) {
          const receivers = await getReceivers(message.topic) || [];
          receivers.forEach((receiver) => {
            promises.push(send(receiver, message));
          });
        }
        break;
      case "ping":
        promises.push(send(connectionId, { type: "pong" }));
        break;
    }
  }

  await Promise.all(promises);
}

function handleConnect(connectionId: string) {
  // Nothing to do
  console.log(`Connected: ${connectionId}`);
}

async function handleDisconnect(connectionId: string) {
  console.log(`Disconnected: ${connectionId}`);
  // Remove the connection from all topics
  // This is quite expensive, as we need to go through all topics in the table
  const promises: Array<Promise<void | PromiseResult<DynamoDB.UpdateItemOutput, AWSError>>> = [];
  for await (const item of scanItems(dynamoDb, TOPICS_TABLE)) {
    const receivers = item.receivers?.SS ?? [];
    if (receivers.includes(connectionId)) {
      promises.push(unsubscribe(item.name.S!, connectionId));
    }
  }

  await Promise.all(promises);
}

export async function handler(
  event: HttpV2WebsocketEvent
): Promise<HttpV2Response> {
  if (!TOPICS_TABLE) {
    return { statusCode: 502, body: "Not configured" };
  }

  // The AWS "simple chat" example uses event.requestContext.domainName/...stage, but that doesn't work with custom domain
  // names. It also doesn't matter, this is anyways an internal (AWS->AWS) call.
  const apigwManagementApi = new ApiGatewayManagementApi({
    apiVersion: "2018-11-29",
    endpoint: `https://${event.requestContext.apiId}.execute-api.${AWS_REGION}.amazonaws.com/${event.requestContext.stage}`,
  });
  const send = async (connectionId: string, message: any) => {
    try {
      await apigwManagementApi
        .postToConnection({
          ConnectionId: connectionId,
          Data: JSON.stringify(message),
        })
        .promise();
    } catch (err) {
      if (err.statusCode === 410) {
        console.log(`Found stale connection, deleting ${connectionId}`);
        await handleDisconnect(connectionId);
      } else {
        // Log, but otherwise ignore: There's not much we can do, really.
        console.log(`Error when sending to ${connectionId}: ${err.message}`);
      }
    }
  };

  try {
    switch (event.requestContext.routeKey) {
      case "$connect":
        handleConnect(event.requestContext.connectionId);
        break;
      case "$disconnect":
        await handleDisconnect(event.requestContext.connectionId);
        break;
      case "$default":
        await handleYWebRtcMessage(
          event.requestContext.connectionId,
          JSON.parse(event.body),
          send
        );
        break;
    }

    return { statusCode: 200 };
  } catch (err) {
    console.log(`Error ${event.requestContext.connectionId}`, err);
    return { statusCode: 500, body: err.message };
  }
}
