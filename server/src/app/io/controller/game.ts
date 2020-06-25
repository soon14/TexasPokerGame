'use strict';
import BaseSocketController from '../../../lib/baseSocketController';
import { IRoomInfo, ISit } from '../../../interface/IGameRoom';
import { EGameStatus, PokerGame } from '../../core/PokerGame';
import { IPlayer } from '../../core/Player';
import { ILinkNode, Link } from '../../../utils/Link';
import { IGame } from '../../../interface/IGame';
import { ICommandRecord } from '../../../interface/ICommandRecord';
import { IPlayerDTO } from '../../../interface/IPlayer';

class GameController extends BaseSocketController {
  async playGame() {
    try {
      const roomInfo = await this.getRoomInfo();
      const gameService = await this.app.applicationContext.getAsync('GameService');
      const playerRecordService = await this.app.applicationContext.getAsync('PlayerRecordService');
      console.log('players===============sit11111111111', roomInfo.sit);
      let sitDownPlayer: IPlayer[] = [];
      if (roomInfo.sitLink) {
        let currNode: ILinkNode<IPlayer> | null = roomInfo.sitLink;
        const currPlayer = currNode.node;
        sitDownPlayer.push(currNode.node);
        while (currNode && currPlayer.userId !== currNode.next?.node.userId) {
          const next: ILinkNode<IPlayer> | null = currNode.next;
          if (next) {
            sitDownPlayer.push(next.node);
          }
          currNode = next;
        }
      } else {
        sitDownPlayer = roomInfo.sit.filter(
          s => s.player && s.player.counter > 0).map(sit => sit.player);
        if (sitDownPlayer.length < 2) {
          throw 'player not enough';
        }
        roomInfo.sitLink = new Link<IPlayer>(sitDownPlayer).link;
      }
      console.log('sitDownPlayer===============sit11111111111', sitDownPlayer);
      console.log('roomInfo.sitLink===============sit11111111111',
        roomInfo.sitLink);
      if (sitDownPlayer.length < 2) {
        throw 'player not enough';
      }
      console.log('roomConfig-------------------', roomInfo.config);
      if (!roomInfo.game) {
        roomInfo.game = null;
        roomInfo.game = new PokerGame({
          users: sitDownPlayer,
          isShort: roomInfo.config.isShort,
          smallBlind: 1,
          actionRoundComplete: () => {
            let slidePots: number [] = [];
            if (roomInfo.game) {
              console.log('come in', roomInfo.game.status);
              if (roomInfo.game.status < 6 && roomInfo.game.playerSize > 1) {
                roomInfo.game.sendCard();
                roomInfo.game.startActionRound();
                // has allin，deal slide pot
                if (roomInfo.game.allInPlayers.length > 0) {
                  slidePots = roomInfo.game.slidePots;
                }
                this.nsp.adapter.clients([ this.roomNumber ],
                  (err: any, clients: any) => {
                    if (roomInfo.game) {
                      // 更新common card
                      this.nsp.to(this.roomNumber).emit('online', {
                        clients,
                        action: 'actionComplete',
                        target: 'participator',
                        data: {
                          slidePots,
                          commonCard: roomInfo.game.commonCard,
                        },
                      });
                    }
                  });
              }
            }
          },
          gameOverCallBack: async () => {
            if (roomInfo.game) {
              // game over
              roomInfo.game.allPlayer.forEach(gamePlayer => {
                console.log('player =================== game over', gamePlayer);
                const player = roomInfo.players.find(
                  (p: IPlayer) => p.userId === gamePlayer.userId);
                const sit = roomInfo.sit.find(
                  (s: ISit) => s.player?.userId === gamePlayer.userId);
                if (player && sit) {
                  player.counter = gamePlayer.counter;
                  player.actionCommand = '';
                  player.actionSize = 0;
                  player.type = '';
                  sit.player.counter = gamePlayer.counter;
                  sit.player.actionCommand = '';
                  sit.player.actionSize = 0;
                  sit.player.type = '';
                }
              });
              console.log('allPlayer =================== game over', roomInfo.game.allPlayer);
            }
            this.nsp.adapter.clients([ this.roomNumber ],
              (err: any, clients: any) => {
                if (roomInfo.game) {
                  // game over show winner
                  if (roomInfo.game.status === 7) {
                    let winner: any = [
                      [
                        {
                          ...roomInfo.game.winner[0][0],
                          handCard: [],
                        }]];
                    let allPlayers = winner[0];
                    // only player, other fold
                    if (roomInfo.game.getPlayers().length !== 1) {
                      winner = roomInfo.game.winner;
                      allPlayers = roomInfo.game.getPlayers();
                    }
                    this.nsp.to(this.roomNumber).emit('online', {
                      clients,
                      action: 'gameOver',
                      target: 'participator',
                      data: {
                        winner,
                        allPlayers,
                        commonCard: roomInfo.game.commonCard,
                      },
                    });
                  }
                  // new game
                  setTimeout(() => {
                    this.reStart();
                  }, 10000);
                }
              });
            // update game info
            const gameRecord: IGame = {
              id: roomInfo.gameId,
              pot: roomInfo.game?.pot || 0,
              commonCard: roomInfo.game?.commonCard.join(',') || '',
              winners: JSON.stringify(roomInfo.game?.winner).replace(' ', ''),
              status: roomInfo.game?.gameOverType || 0,
            };
            const result = await gameService.update(gameRecord);
            if (!result.succeed) {
              throw 'update game error';
            }
          },
          autoActionCallBack: async (command, userId) => {
            // fold change status: -1
            if (command === 'fold') {
              console.log('cccc', command, userId);
              console.log('roomInfo', roomInfo.players);
              roomInfo.players.forEach(p => {
                if (p.userId === userId) {
                  p.status = -1;
                }
              });
              console.log('roomInfo', roomInfo.players);
              roomInfo.sit.forEach((s: ISit) => {
                if (s.player && s.player.userId === userId) {
                  delete s.player;
                }
              });
            }

            // todo notice next player action
            await this.updateGameInfo();
            console.log('auto Action');
          },
        });

        roomInfo.game.play();
        roomInfo.game.startActionRound();
        console.log('hand card', roomInfo.game.allPlayer);
        // update counter, pot, status
        await this.updateGameInfo();
        for (const p of roomInfo.players) {
          const player = roomInfo.game?.allPlayer.find(
            player => player.userId === p.userId);
          const msg = this.ctx.helper.parseMsg('handCard', {
            handCard: player?.getHandCard(),
          }, { client: p.socketId });
          this.nsp.emit(p.socketId, msg);
          const playerRecord: IPlayerDTO = {
            roomNumber: this.roomNumber,
            gameId: roomInfo.gameId || 0,
            userId: player?.userId || '',
            buyIn: p.buyIn,
            counter: p.counter,
            handCard: player?.getHandCard().join(',') || '',
          };
          await playerRecordService.add(playerRecord);
        }
        // add game record
        const gameRecord: IGame = {
          roomNumber: this.roomNumber,
          pot: 0,
          commonCard: '',
          status: 0,
        };
        const result = await gameService.add(gameRecord);
        if (result.succeed) {
          roomInfo.gameId = result.id;
        } else {
          throw 'game add error';
        }
        // add game BB SB action record
        const BB = roomInfo.game.BBPlayer;
        const SB = roomInfo.game.SBPlayer;
        const BBCommandRecord: ICommandRecord = {
          roomNumber: this.roomNumber,
          userId: BB.userId,
          type: BB.type,
          gameStatus: 0,
          pot: 3,
          commonCard: '',
          command: 'bb:2',
          gameId: result.id,
          counter: BB.counter,
        };
        const SBCommandRecord: ICommandRecord = {
          roomNumber: this.roomNumber,
          userId: SB.userId,
          type: SB.type,
          gameStatus: 0,
          pot: 1,
          commonCard: '',
          command: 'sb:1',
          gameId: result.id,
          counter: SB.counter,
        };
        const commandRecordService = await this.app.applicationContext.getAsync('CommandRecordService');
        await commandRecordService.add(SBCommandRecord);
        await commandRecordService.add(BBCommandRecord);
      } else {
        throw 'game already paling';
      }
    } catch (error) {
      this.app.logger.error(error);
    }
  }

  async reStart() {
    try {
      const roomInfo: IRoomInfo = await this.getRoomInfo();
      const dealer = roomInfo.game?.allPlayer.filter(gamePlayer => {
        return !!roomInfo.sit.find(s => s.player?.userId === gamePlayer.userId
          && s.player.counter > 0 && s.player?.userId !== roomInfo.sitLink?.node.userId);
      })[0];
      console.log('dealer -------', dealer);
      roomInfo.game = null;
      // init player status
      roomInfo.players.forEach(p => {
        p.status = 0;
      });
      console.log('sit =======', roomInfo.sit);
      // calculate re buy in
      roomInfo.sit.forEach((s: ISit) => {
        if (s.player) {
          const player = roomInfo.players.find(
            p => p.userId === s.player?.userId);
          if (player) {
            s.player.counter += Number(player.reBuy);
            console.log('cal reBuy ===============================', s.player,
              player.reBuy);
            player.reBuy = 0;
            s.player.reBuy = 0;
          }
        }
      });

      // clear counter not enough player
      roomInfo.sit.forEach((s: ISit) => {
        if (s.player && s.player.counter === 0) {
          delete s.player;
        }
      });

      const players = roomInfo.sit.filter(s => s.player && s.player.counter > 0)
        .map(s => s.player) || [];
      let link: ILinkNode<IPlayer> | null = new Link<IPlayer>(players).link;
      if (players.length >= 2) {
        // init sit link
        console.log(players, 'players===========');
        while (link?.node.userId !== dealer?.userId) {
          link = link?.next || null;
        }
        roomInfo.sitLink = link;
        console.log('dealer ===================', dealer, link);
        // new game
        this.nsp.adapter.clients([ this.roomNumber ],
          async (err: any, clients: any) => {
            // 广播信息
            this.nsp.to(this.roomNumber).emit('online', {
              clients,
              action: 'newGame',
              target: 'participator',
              data: {},
            });
            await this.playGame();
          });
      } else {
        roomInfo.sitLink = null;
        console.log('come in only one player');
        // player not enough
        this.nsp.adapter.clients([ this.roomNumber ],
          async (err: any, clients: any) => {
            // 广播信息
            this.nsp.to(this.roomNumber).emit('online', {
              clients,
              action: 'pause',
              target: 'participator',
              data: {
                players: roomInfo.players,
                sitList: roomInfo.sit,
              },
            });
          });
      }
    } catch (e) {
      console.log(e + 'restart ex');
    }
  }

  async buyIn() {
    try {
      const userInfo: IPlayer = await this.getUserInfo();
      const roomInfo: IRoomInfo = await this.getRoomInfo();
      const { payload } = this.ctx.args[0] || {};
      const { buyInSize } = payload;
      // find current player
      const player = roomInfo.players.find(
        (p: IPlayer) => p.userId === userInfo.userId);
      console.log(userInfo, 'userInfo------', player);
      const isGaming = !!roomInfo.game;
      if (player) {
        if (roomInfo.game) {
          const inTheGame = roomInfo.game.allPlayer.find(
            p => p.userId === userInfo.userId);
          // player in the game, can't buy in
          if (inTheGame) {
            player.reBuy += Number(buyInSize);
            player.buyIn += Number(buyInSize);
            console.log('come in');
          }
        } else {
          player.buyIn += Number(buyInSize);
          player.counter += Number(buyInSize);
        }
      } else {
        const player: IPlayer = {
          counter: Number(buyInSize),
          buyIn: Number(buyInSize),
          ...userInfo,
        };
        roomInfo.players.push(player);
      }
      console.log(player, 'buy in player', roomInfo.players);
      if (!isGaming) {
        this.nsp.adapter.clients([ this.roomNumber ],
          (err: any, clients: any) => {
            // 广播信息
            this.nsp.to(this.roomNumber).emit('online', {
              clients,
              action: 'players',
              target: 'participator',
              data: {
                players: roomInfo.players,
              },
            });
          });
      }
    } catch (e) {
      console.log(e);
    }
  }

  async handCard() {
    try {
      const userInfo: IPlayer = await this.getUserInfo();
      const roomInfo: IRoomInfo = await this.getRoomInfo();
      const player = roomInfo.players.find(
        (p: IPlayer) => p.nickName === userInfo.nickName);
      console.log(userInfo, 'userInfo------');
      if (player && roomInfo.game) {
        const gamePlayer = roomInfo.game.allPlayer.find(
          p => player.socketId === p.socketId);
        if (gamePlayer) {
          const msg = this.ctx.helper.parseMsg('handCard', {
            handCard: gamePlayer.getHandCard(),
          }, { client: player.socketId });
          console.log(msg, 'game msg---------');
          this.nsp.emit(player.socketId, msg);
        }
      } else {
        throw 'game over';
      }
    } catch (e) {
      console.log(e);
    }
  }

  async sitDown() {
    try {
      const { payload } = this.message;
      const sitList = payload.sitList;
      const roomInfo = await this.getRoomInfo();
      console.log('sitList===========', sitList);
      // update player isSit
      // roomInfo.players.forEach(p => {
      //   const sit = sitList.find((s: ISit) => s.player?.userId === p.userId);
      //   p.isSit = !!sit;
      // });
      roomInfo.sit = sitList;
      this.nsp.adapter.clients([ this.roomNumber ], (err: any, clients: any) => {
        // 广播信息
        this.nsp.to(this.roomNumber).emit('online', {
          clients,
          action: 'sitList',
          target: 'participator',
          data: {
            sitList,
          },
        });
      });
    } catch (e) {
      console.log(e);
    }
  }

  async action() {
    try {
      const { payload } = this.message;
      const userInfo: IPlayer = await this.getUserInfo();
      const roomInfo = await this.getRoomInfo();
      console.log('action：', payload.command);
      console.log('action：', roomInfo.game && roomInfo.game.currPlayer.node,
        userInfo);
      if (roomInfo.game && roomInfo.game.currPlayer.node.userId ===
        userInfo.userId) {
        const currPlayer = roomInfo.game.currPlayer.node;
        roomInfo.game.action(payload.command);
        const commandArr = payload.command.split(':');
        const command = commandArr[0];
        // fold change status: -1
        if (command === 'fold') {
          roomInfo.players.forEach(p => {
            if (p.userId === userInfo.userId) {
              p.status = -1;
            }
          });
        }
        console.log('fold ===============', roomInfo.players,
          roomInfo.game.allPlayer);
        // todo notice next player action
        await this.updateGameInfo();
        console.log('curr player', roomInfo.game.currPlayer.node);
        // add game record
        let status = 0;
        const commonCard = roomInfo.game.commonCard;
        if (commonCard.length === 3) {
          status = EGameStatus.GAME_FLOP;
        }
        if (commonCard.length === 4) {
          status = EGameStatus.GAME_TURN;
        }
        if (commonCard.length === 5) {
          status = EGameStatus.GAME_RIVER;
        }
        if (commonCard.length === 6) {
          status = EGameStatus.GAME_SHOWDOWN;
        }
        const commandRecord: ICommandRecord = {
          roomNumber: this.roomNumber,
          userId: userInfo.userId,
          type: currPlayer.type,
          gameStatus: status,
          pot: roomInfo.game?.pot || 0,
          commonCard: roomInfo.game?.commonCard.join(',') || '',
          command: payload.command,
          gameId: roomInfo.gameId || 0,
          counter: currPlayer.counter,
        };
        const commandRecordService = await this.app.applicationContext.getAsync('CommandRecordService');
        await commandRecordService.add(commandRecord);
      } else {
        throw 'action flow incorrect';
      }
    } catch (e) {
      console.log(e);
    }
  }
}

module.exports = GameController;
