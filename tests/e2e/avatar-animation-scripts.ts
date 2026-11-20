// 아바타 창 안에서 도는 시험용 글. tests/e2e/test_avatar_animation.py의 page.evaluate 글을 그대로 옮겼다.

import { REPO_ROOT } from "../../src/core/assets.ts";

export const createCharacter = `async () => {
      const { createCharacter, AnimationMixer } = await import('/@fs/${REPO_ROOT.replaceAll("\\", "/")}/tests/e2e/avatar-probe.ts');
      // Observe the transforms produced by the shipped mixer and model.
      const update = AnimationMixer.prototype.update;
      AnimationMixer.prototype.update = function (delta) {
        const result = update.call(this, delta);
        window.bodyRig = this.getRoot().getObjectByName('Body').parent;
        return result;
      };
      const stage = document.createElement('div');
      stage.style.cssText = 'width:146px;height:162px';
      const canvas = stage.appendChild(document.createElement('canvas'));
      document.body.replaceChildren(stage);
      window.surfaces = [];
      window.character = await createCharacter(canvas,
        (pose, clip) => { window.currentPose = { pose, clip }; },
        available => {
          surfaces.push(available);
          if (available) {
            const copy = document.createElement('canvas');
            copy.width = canvas.width;
            copy.height = canvas.height;
            const ctx = copy.getContext('2d');
            ctx.drawImage(canvas, 0, 0);
            window.restoredPixels = ctx.getImageData(0, 0, copy.width, copy.height).data
              .some((value, i) => i % 4 === 3 && value > 128);
          }
        });
      window.gpu = canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
    }`;

export const bubbleState = `() => {
      __send('prefs', {corner:'bottom-right', still:false});
      __send('visibility', {visible:true, id:1, animate:false});
      const base = {instance:'pops', connected:true, mode:'ready', capture:'off', choices:[]};
      let revision = 0;
      window.publishCard = changes => __send('snapshot', {...base, ...changes, revision:++revision});
      publishCard({message:{id:'reply', text:'정부24에서 확인할까요?'}});
      const card = document.getElementById('card');
      const skin = card.querySelector('.bubble');
      const opacity = () => Number(getComputedStyle(skin).opacity);
      const enter = skin.getAnimations()[0];
      enter.pause();
      enter.currentTime = enter.effect.getComputedTiming().duration * .28;
      const rising = opacity();
      publishCard({});
      const leaving = opacity(), closingInert = card.inert;
      const exit = skin.getAnimations()[0];
      exit.pause();
      exit.currentTime = exit.playbackRate < 0 ? exit.currentTime * .45 : exit.effect.getComputedTiming().duration * .4;
      const falling = opacity();
      publishCard({choiceSetId:'approval', prompt:'이 내용을 확인할까요?', choices:[{key:'ok',label:'확인'}]});
      return {rising, leaving, falling, renewed:opacity(), closingInert, reopenedInert:card.inert};
    }`;

export const swapChoice = `() => {
      const oldChoice = document.querySelector('#choices button');
      publishCard({choiceSetId:'latest', prompt:'이 내용을 확인할까요?', choices:[{key:'ok',label:'확인'}]});
      oldChoice.click();
      const skin = document.querySelector('.bubble');
      return [getComputedStyle(skin).opacity, skin.getAnimations().length];
    }`;

export const menuSetup = `() => {
      __send('prefs', {corner:'top-left', still:false});
      __send('visibility', {visible:true, id:10, animate:false});
      __send('snapshot', {instance:'visibility', revision:1, connected:true, mode:'working', busy:true,
        capture:'off', choices:[], message:{id:'reply',text:'찾고 있어요.'}});
    }`;

export const menuMid = `() => {
      const root = document.getElementById('overlay');
      const parts = ['#avatar','.panel','#card'].map(s => document.querySelector(s));
      const opacities = () => parts.map(el => Number(getComputedStyle(el).opacity));
      __send('visibility', {visible:false, id:11, animate:true});
      const exit = root.getAnimations()[0];
      exit.pause();
      exit.currentTime = exit.effect.getComputedTiming().duration * .6;
      const fading = opacities();
      __send('visibility', {visible:true, id:12, animate:true});
      const stop = document.getElementById('stop'), button = stop.getBoundingClientRect();
      const target = document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2);
      if (target?.closest('button') === stop) target.click();
      return {fading, reversing:opacities(), acks:__calls.filter(c => c[0]==='visibilityDone')};
    }`;

export const immediate = `still => {
          __send('prefs', {corner:'top-left', still});
          __send('visibility', {visible:false, id:14, animate:true});
          __send('visibility', {visible:true, id:15, animate:true});
          return {animations:document.getElementById('overlay').getAnimations().length,
                  acks:__calls.filter(c => c[0]==='visibilityDone').slice(-2)};
        }`;

export const loseGpu = `() => {
      window.avatarGpu = document.querySelector('#character').getContext('webgl2').getExtension('WEBGL_lose_context');
      avatarGpu.loseContext();
    }`;

export const resetSnapshot = `() => window.__send('snapshot', {
      instance:'reset', revision:1, connected:true, state:'OBSERVING', mode:'working', capture:'off', choices:[]
    })`;
