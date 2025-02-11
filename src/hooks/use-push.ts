import { getRandomString } from 'billd-utils';
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { fetchRtcV1Publish } from '@/api/srs';
import {
  DanmuMsgTypeEnum,
  IAdminIn,
  ICandidate,
  IDanmu,
  ILiveUser,
  IOffer,
  MediaTypeEnum,
} from '@/interface';
import { SRSWebRTCClass } from '@/network/srsWebRtc';
import { WebRTCClass } from '@/network/webRtc';
import {
  WebSocketClass,
  WsConnectStatusEnum,
  WsMsgTypeEnum,
} from '@/network/webSocket';
import { useNetworkStore } from '@/store/network';
import { useUserStore } from '@/store/user';

export function usePush({
  localVideoRef,
  isSRS,
}: {
  localVideoRef;
  isSRS?: boolean;
}) {
  const route = useRoute();
  const router = useRouter();
  const userStore = useUserStore();
  const networkStore = useNetworkStore();

  const roomId = ref<string>(getRandomString(15));
  const danmuStr = ref('');
  const roomName = ref('');
  const isDone = ref(false);
  const joined = ref(false);
  const disabled = ref(false);
  const localStream = ref();
  const offerSended = ref(new Set());

  const track = reactive({
    audio: true,
    video: true,
  });
  const streamurl = ref(
    `webrtc://${
      process.env.NODE_ENV === 'development' ? 'localhost' : 'live.hsslive.cn'
    }/live/livestream/${roomId.value}`
  );
  const flvurl = ref(
    `${
      process.env.NODE_ENV === 'development'
        ? 'http://localhost:5001'
        : 'https://live.hsslive.cn/srsflv'
    }/live/livestream/${roomId.value}.flv`
  );

  const damuList = ref<IDanmu[]>([]);
  const liveUserList = ref<ILiveUser[]>([]);

  const allMediaTypeList = {
    [MediaTypeEnum.camera]: {
      type: MediaTypeEnum.camera,
      txt: '摄像头',
    },
    [MediaTypeEnum.screen]: {
      type: MediaTypeEnum.screen,
      txt: '窗口',
    },
  };
  const currMediaTypeList = ref<
    {
      type: MediaTypeEnum;
      txt: string;
    }[]
  >([]);
  const currMediaType = ref<{
    type: MediaTypeEnum;
    txt: string;
  }>();

  function startLive() {
    if (!roomNameIsOk()) return;
    if (currMediaTypeList.value.length <= 0) {
      window.$message.warning('请选择一个素材！');
      return;
    }
    disabled.value = true;

    const ws = new WebSocketClass({
      roomId: roomId.value,
      url:
        process.env.NODE_ENV === 'development'
          ? 'ws://localhost:4300'
          : 'wss://live.hsslive.cn',
      isAdmin: true,
    });
    ws.update();
    initReceive();
    if (isSRS) {
      sendJoin();
    }
  }

  /** 原生的webrtc时，receiver必传 */
  async function startNewWebRtc(receiver?: string) {
    if (isSRS) {
      console.warn('开始new SRSWebRTCClass');
      const rtc = new SRSWebRTCClass({
        roomId: `${roomId.value}___${getSocketId()}`,
      });
      localStream.value.getTracks().forEach((track) => {
        rtc.addTrack({
          track,
          stream: localStream.value,
          direction: 'sendonly',
        });
      });
      try {
        const offer = await rtc.createOffer();
        if (!offer) return;
        await rtc.setLocalDescription(offer);
        const res: any = await fetchRtcV1Publish({
          api: `${
            process.env.NODE_ENV === 'development'
              ? 'http://localhost:1985'
              : 'https://live.hsslive.cn/srs'
          }/rtc/v1/publish/`,
          clientip: null,
          sdp: offer.sdp!,
          streamurl: streamurl.value,
          tid: getRandomString(10),
        });
        await rtc.setRemoteDescription(
          new RTCSessionDescription({ type: 'answer', sdp: res.sdp })
        );
      } catch (error) {
        console.log(error);
      }
    } else {
      console.warn('开始new WebRTCClass');
      const rtc = new WebRTCClass({ roomId: `${roomId.value}___${receiver!}` });
      return rtc;
    }
  }

  function handleCoverImg() {
    const canvas = document.createElement('canvas');
    const { width, height } = localVideoRef.value!.getBoundingClientRect();
    const rate = width / height;
    const coverWidth = width * 0.5;
    const coverHeight = coverWidth / rate;
    canvas.width = coverWidth;
    canvas.height = coverHeight;
    canvas
      .getContext('2d')!
      .drawImage(localVideoRef.value!, 0, 0, coverWidth, coverHeight);
    // webp比png的体积小非常多！因此coverWidth就可以不用压缩太夸张
    const dataURL = canvas.toDataURL('image/webp');
    return dataURL;
  }

  function closeWs() {
    const instance = networkStore.wsMap.get(roomId.value);
    instance?.close();
  }

  function closeRtc() {
    networkStore.rtcMap.forEach((rtc) => {
      rtc.close();
    });
  }

  function addTrack() {
    if (!localStream.value) return;
    liveUserList.value.forEach((item) => {
      if (item.socketId !== getSocketId()) {
        localStream.value.getTracks().forEach((track) => {
          const rtc = networkStore.getRtcMap(
            `${roomId.value}___${item.socketId}`
          );
          rtc?.addTrack(track, localStream.value);
        });
      }
    });
  }

  function sendJoin() {
    const instance = networkStore.wsMap.get(roomId.value);
    if (!instance) return;
    instance.send({
      msgType: WsMsgTypeEnum.join,
      data: {
        roomName: roomName.value,
        coverImg: handleCoverImg(),
        srs: isSRS
          ? {
              streamurl: streamurl.value,
              flvurl: flvurl.value,
            }
          : undefined,
        track,
        userInfo: userStore.userInfo,
      },
    });
  }

  async function sendOffer({
    sender,
    receiver,
  }: {
    sender: string;
    receiver: string;
  }) {
    if (isDone.value) return;
    const instance = networkStore.wsMap.get(roomId.value);
    if (!instance) return;
    const rtc = networkStore.getRtcMap(`${roomId.value}___${receiver}`);
    if (!rtc) return;
    const sdp = await rtc.createOffer();
    await rtc.setLocalDescription(sdp);
    instance.send({
      msgType: WsMsgTypeEnum.offer,
      data: { sdp, sender, receiver },
    });
  }

  function batchSendOffer() {
    liveUserList.value.forEach(async (item) => {
      if (
        !offerSended.value.has(item.socketId) &&
        item.socketId !== getSocketId()
      ) {
        await startNewWebRtc(item.socketId);
        await addTrack();
        console.warn('new WebRTCClass完成');
        console.log('执行sendOffer', {
          sender: getSocketId(),
          receiver: item.socketId,
        });
        sendOffer({ sender: getSocketId(), receiver: item.socketId });
        offerSended.value.add(item.socketId);
      }
    });
  }

  function getSocketId() {
    return networkStore.wsMap.get(roomId.value!)?.socketIo?.id || '-1';
  }

  function initReceive() {
    const instance = networkStore.wsMap.get(roomId.value);
    if (!instance?.socketIo) return;
    // websocket连接成功
    instance.socketIo.on(WsConnectStatusEnum.connect, () => {
      console.log('【websocket】websocket连接成功', instance.socketIo?.id);
      if (!instance) return;
      instance.status = WsConnectStatusEnum.connect;
      instance.update();
      if (!isSRS) {
        sendJoin();
      }
    });

    // websocket连接断开
    instance.socketIo.on(WsConnectStatusEnum.disconnect, () => {
      console.log('【websocket】websocket连接断开', instance);
      if (!instance) return;
      instance.status = WsConnectStatusEnum.disconnect;
      instance.update();
    });

    // 收到offer
    instance.socketIo.on(WsMsgTypeEnum.offer, async (data: IOffer) => {
      console.warn('【websocket】收到offer', data);
      if (isSRS) return;
      if (!instance) return;
      if (data.data.receiver === getSocketId()) {
        console.log('收到offer，这个offer是发给我的');
        const rtc = await startNewWebRtc(data.data.sender);
        if (rtc) {
          await rtc.setRemoteDescription(data.data.sdp);
          const sdp = await rtc.createAnswer();
          await rtc.setLocalDescription(sdp);
          instance.send({
            msgType: WsMsgTypeEnum.answer,
            data: { sdp, sender: getSocketId(), receiver: data.data.sender },
          });
        }
      } else {
        console.log('收到offer，但是这个offer不是发给我的');
      }
    });

    // 收到answer
    instance.socketIo.on(WsMsgTypeEnum.answer, async (data: IOffer) => {
      console.warn('【websocket】收到answer', data);
      if (isSRS) return;
      if (isDone.value) return;
      if (!instance) return;
      const rtc = networkStore.getRtcMap(`${roomId.value}___${data.socketId}`);
      if (!rtc) return;
      rtc.rtcStatus.answer = true;
      rtc.update();
      if (data.data.receiver === getSocketId()) {
        console.log('收到answer，这个answer是发给我的');
        await rtc.setRemoteDescription(data.data.sdp);
      } else {
        console.log('收到answer，但这个answer不是发给我的');
      }
    });

    // 收到candidate
    instance.socketIo.on(WsMsgTypeEnum.candidate, (data: ICandidate) => {
      console.warn('【websocket】收到candidate', data);
      if (isSRS) return;
      if (isDone.value) return;
      if (!instance) return;
      const rtc = networkStore.getRtcMap(`${roomId.value}___${data.socketId}`);
      if (!rtc) return;
      if (data.socketId !== getSocketId()) {
        console.log('不是我发的candidate');
        const candidate = new RTCIceCandidate({
          sdpMid: data.data.sdpMid,
          sdpMLineIndex: data.data.sdpMLineIndex,
          candidate: data.data.candidate,
        });
        rtc.peerConnection
          ?.addIceCandidate(candidate)
          .then(() => {
            console.log('candidate成功');
          })
          .catch((err) => {
            console.error('candidate失败', err);
          });
      } else {
        console.log('是我发的candidate');
      }
    });

    // 当前所有在线用户
    instance.socketIo.on(WsMsgTypeEnum.roomLiveing, (data: IAdminIn) => {
      console.log('【websocket】收到管理员正在直播', data);
    });

    // 当前所有在线用户
    instance.socketIo.on(WsMsgTypeEnum.liveUser, () => {
      console.log('【websocket】当前所有在线用户');
      if (!instance) return;
    });

    // 收到用户发送消息
    instance.socketIo.on(WsMsgTypeEnum.message, (data) => {
      console.log('【websocket】收到用户发送消息', data);
      if (!instance) return;
      damuList.value.push({
        socketId: data.socketId,
        msgType: DanmuMsgTypeEnum.danmu,
        msg: data.data.msg,
      });
    });

    // 用户加入房间完成
    instance.socketIo.on(WsMsgTypeEnum.joined, (data) => {
      console.log('【websocket】用户加入房间完成', data);
      joined.value = true;
      liveUserList.value.push({
        socketId: `${getSocketId()}`,
      });
      if (isSRS) {
        startNewWebRtc();
      } else {
        batchSendOffer();
      }
    });

    // 其他用户加入房间
    instance.socketIo.on(WsMsgTypeEnum.otherJoin, (data) => {
      console.log('【websocket】其他用户加入房间', data);
      liveUserList.value.push({
        socketId: data.data.socketId,
      });
      damuList.value.push({
        socketId: data.data.socketId,
        userInfo: data.data.userInfo,
        msgType: DanmuMsgTypeEnum.otherJoin,
        msg: '',
      });
      if (isSRS) return;
      if (joined.value) {
        batchSendOffer();
      }
    });

    // 用户离开房间
    instance.socketIo.on(WsMsgTypeEnum.leave, (data) => {
      console.log('【websocket】用户离开房间', data);
      if (!instance) return;
      instance.socketIo?.emit(WsMsgTypeEnum.leave, {
        roomId: instance.roomId,
      });
    });

    // 用户离开房间完成
    instance.socketIo.on(WsMsgTypeEnum.leaved, (data) => {
      console.log('【websocket】用户离开房间完成', data);
      const res = liveUserList.value.filter(
        (item) => item.socketId !== data.socketId
      );
      liveUserList.value = res;
      damuList.value.push({
        socketId: data.socketId,
        msgType: DanmuMsgTypeEnum.userLeaved,
        msg: '',
      });
    });
  }

  function roomNameIsOk() {
    if (!roomName.value.length) {
      window.$message.warning('请输入房间名！');
      return false;
    }
    if (roomName.value.length < 3 || roomName.value.length > 10) {
      window.$message.warning('房间名要求3-10个字符！');
      return false;
    }
    return true;
  }

  /** 摄像头 */
  async function startGetUserMedia() {
    if (!localStream.value) {
      // WARN navigator.mediaDevices在localhost和https才能用，http://192.168.1.103:8000局域网用不了
      const event = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      console.log('getUserMedia成功', event);
      currMediaType.value = allMediaTypeList[MediaTypeEnum.camera];
      currMediaTypeList.value.push(allMediaTypeList[MediaTypeEnum.camera]);
      if (!localVideoRef.value) return;
      localVideoRef.value.srcObject = event;
      localStream.value = event;
    }
  }

  /** 窗口 */
  async function startGetDisplayMedia() {
    if (!localStream.value) {
      // WARN navigator.mediaDevices.getDisplayMedia在localhost和https才能用，http://192.168.1.103:8000局域网用不了
      const event = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      const audio = event.getAudioTracks();
      const video = event.getVideoTracks();
      track.audio = !!audio.length;
      track.video = !!video.length;
      console.log('getDisplayMedia成功', event);
      currMediaType.value = allMediaTypeList[MediaTypeEnum.screen];
      currMediaTypeList.value.push(allMediaTypeList[MediaTypeEnum.screen]);
      if (!localVideoRef.value) return;
      localVideoRef.value.srcObject = event;
      localStream.value = event;
    }
  }
  function keydownDanmu(event: KeyboardEvent) {
    const key = event.key.toLowerCase();
    if (key === 'enter') {
      event.preventDefault();
      sendDanmu();
    }
  }

  function confirmRoomName() {
    if (!roomNameIsOk()) return;
    disabled.value = true;
  }

  function sendDanmu() {
    if (!danmuStr.value.length) {
      window.$message.warning('请输入弹幕内容！');
      return;
    }
    const instance = networkStore.wsMap.get(roomId.value);
    if (!instance) {
      window.$message.error('还没开播，不能发送弹幕');
      return;
    }
    instance.send({
      msgType: WsMsgTypeEnum.message,
      data: { msg: danmuStr.value },
    });
    damuList.value.push({
      socketId: getSocketId(),
      msgType: DanmuMsgTypeEnum.danmu,
      msg: danmuStr.value,
    });
    danmuStr.value = '';
  }

  /** 结束直播 */
  function endLive() {
    disabled.value = false;
    closeRtc();
    currMediaTypeList.value = [];
    localStream.value = null;
    localVideoRef.value!.srcObject = null;
    const instance = networkStore.wsMap.get(roomId.value);
    if (!instance) return;
    instance.send({
      msgType: WsMsgTypeEnum.roomNoLive,
      data: {},
    });
    setTimeout(() => {
      instance.close();
    }, 500);
  }
  async function getAllMediaDevices() {
    const res = await navigator.mediaDevices.enumerateDevices();
    // const audioInput = res.filter(
    //   (item) => item.kind === 'audioinput' && item.deviceId !== 'default'
    // );
    // const videoInput = res.filter(
    //   (item) => item.kind === 'videoinput' && item.deviceId !== 'default'
    // );
    return res;
  }

  async function initPush() {
    router.push({ query: { ...route.query, roomId: roomId.value } });
    const all = await getAllMediaDevices();
    allMediaTypeList[MediaTypeEnum.camera] = {
      txt: all.find((item) => item.kind === 'videoinput')?.label || '摄像头',
      type: MediaTypeEnum.camera,
    };
    localVideoRef.value.addEventListener('loadstart', () => {
      console.warn('视频流-loadstart');
      const rtc = networkStore.getRtcMap(roomId.value);
      if (!rtc) return;
      rtc.rtcStatus.loadstart = true;
      rtc.update();
    });

    localVideoRef.value.addEventListener('loadedmetadata', () => {
      console.warn('视频流-loadedmetadata');
      const rtc = networkStore.getRtcMap(roomId.value);
      if (!rtc) return;
      rtc.rtcStatus.loadedmetadata = true;
      rtc.update();
      if (isSRS) return;
      if (joined.value) {
        batchSendOffer();
      }
    });
  }

  return {
    initPush,
    confirmRoomName,
    getSocketId,
    startGetDisplayMedia,
    startGetUserMedia,
    startLive,
    endLive,
    closeWs,
    closeRtc,
    sendDanmu,
    keydownDanmu,
    disabled,
    danmuStr,
    roomName,
    damuList,
    liveUserList,
    currMediaTypeList,
  };
}
