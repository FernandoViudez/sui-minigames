/* eslint-disable prettier/prettier */
import {
  BadRequestException,
  UnauthorizedException,
  UseFilters,
  UsePipes,
} from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { environment } from '../../environment/environment';
import { GameSession } from '../type/game-session.type';
import { BlockchainQueryService } from '../../providers/blockchain-query.service';
import { GameBoard } from '../interface/game-board.interface';
import { TurnOverCardDto } from '../dto/turn-over-card.dto';
import { Card } from '../interface/card.interface';
import { memotestConstants } from '../constants/constants';
import { MemotestContractService } from './memotest-contract.service';
import { validationPipeConfig } from '../../_config/validation-pipe.config';
import { constants } from '../../environment/constants';
import { GameBoardError } from '../errors/game-board.error';
import { GeneralError } from '../errors/general.error';
import { MemotestExceptionsFilter } from '../errors/memotest-error-filter';
import { Namespace } from '../../_type/socket-namespaces.type';
import { PlayerService } from './player.service';
import { GameSessionService } from './game-session.service';
@UseFilters(MemotestExceptionsFilter)
@WebSocketGateway(environment.sockets.port, {
  ...constants.socketConfig,
  namespace: Namespace.memotest,
})
export class TurnOverCardGateway {
  @WebSocketServer()
  private server: Server;
  constructor(
    private readonly blockchainQueryService: BlockchainQueryService,
    private readonly memotestContractService: MemotestContractService,
    private readonly playerService: PlayerService,
    private readonly gameSessionService: GameSessionService,
  ) {}
  @UsePipes(validationPipeConfig)
  @SubscribeMessage('turn-over-card')
  async onTurnOverCard(
    @MessageBody() data: TurnOverCardDto,
    @ConnectedSocket() client: Socket,
  ) {
    const player = await this.playerService.getPlayerFromSocket(client.id);
    const gameSession: GameSession =
      await this.gameSessionService.getGameSessionFromRoomId(player.roomId);

    if (gameSession.currentTurn.cards.length == 2) {
      throw new BadRequestException(GeneralError.cantTurnOver);
    }

    const gameBoard = (await this.blockchainQueryService.retry<GameBoard>(
      this.checkTurn.bind(this),
      [gameSession, player.id, false],
    )) as GameBoard;

    let currentCard = this.getCardFromPosition(gameBoard, data.position);

    if (
      gameSession.currentTurn.cards.length &&
      gameSession.currentTurn.cards[0].position == data.position
    ) {
      throw new BadRequestException(
        GeneralError.positionAlreadyChosenInSameTurn,
      );
    }

    if (!currentCard) {
      currentCard = this.selectRandomCard(gameBoard.cards);
      const image = await this.gameSessionService.getRandomImage(player.roomId);
      currentCard.fields.image = image;
      await this.memotestContractService.updateCard(
        gameSession.gameBoardObjectId,
        currentCard.fields.id,
        data.position,
        currentCard.fields.location != 0,
        image,
      );
    }

    this.server.to(player.roomId).emit('card-turned-over', {
      id: currentCard.fields.id,
      position: data.position,
      image: currentCard.fields.image,
    });
    client.emit('card-selected', {
      id: currentCard.fields.id,
      position: data.position,
      image: currentCard.fields.image,
    });

    await this.gameSessionService.processCurrentTurn(
      player.roomId,
      {
        position: data.position,
        id: currentCard.fields.id,
      },
      player.id,
    );
  }

  @SubscribeMessage('change-turn')
  async changeTurn(@ConnectedSocket() client: Socket) {
    const player = await this.playerService.getPlayerFromSocket(client.id);
    const gameSession = await this.gameSessionService.getGameSessionFromRoomId(
      player.roomId,
    );
    if (gameSession.currentTurn.cards.length != 2) {
      throw new UnauthorizedException(GameBoardError.invalidCardTimes);
    }
    if (gameSession.currentTurn.playerId != player.id) {
      throw new UnauthorizedException(GameBoardError.incorrectTurn);
    }
    await this.gameSessionService.clearCurrentTurn(player.roomId);
    const gameBoard = (await this.blockchainQueryService.retry<GameBoard>(
      this.checkTurn.bind(this),
      [gameSession, player.id, true],
    )) as GameBoard;
    this.server.to(player.roomId).emit('turn-changed', {
      whoPlays: gameBoard.who_plays,
    });
  }

  private async checkTurn(
    gameSession: GameSession,
    playerId: number,
    playerIdIsOldTurn: boolean,
  ) {
    const gameBoard = await this.blockchainQueryService.getObject<GameBoard>(
      gameSession.gameBoardObjectId,
    );
    let shouldFailWhen: boolean;
    if (playerIdIsOldTurn) {
      shouldFailWhen = gameBoard.who_plays == playerId;
    } else {
      shouldFailWhen = gameBoard.who_plays != playerId;
    }
    if (shouldFailWhen) {
      throw new UnauthorizedException(GameBoardError.incorrectTurn);
    }
    return gameBoard;
  }

  private getCardFromPosition(gameBoard: GameBoard, position: number) {
    const currentCard = gameBoard.cards.find(
      (card) =>
        card.fields.location == position ||
        card.fields.per_location == position,
    );
    return currentCard;
  }

  private selectRandomCard(cards: { fields: Card }[]) {
    const unassignedCards = cards.filter(
      (card) =>
        card.fields.found_by == memotestConstants.zero_address &&
        (!card.fields.location || !card.fields.per_location),
    );
    return unassignedCards[Math.floor(Math.random() * unassignedCards.length)];
  }
}
