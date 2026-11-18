const SECTIONS = {
    services: '복지서비스',
    finder: '서비스 찾기',
    map: '복지지도',
    center: '복지 상담 센터',
    law: '관련 법령',
    agency: '담당 기관',
    similar: '비슷한 서비스',
    faq: '자주 묻는 질문 모음',
    showroom: '보조기기 체험관',
    guide: '이용 안내서',
    notice: '공지',
    custom: '맞춤 서비스',
    applied: '신청 접수됨',
};

const section = new URLSearchParams(location.search).get('section');
if (section && SECTIONS[section]) {
    document.title = `[테스트] 복지 포털 2 - ${SECTIONS[section]}`;
    document.getElementById('page-heading').textContent = SECTIONS[section];
}

if (new URLSearchParams(location.search).get('rotate')) {
    const ticker = document.getElementById('ticker');
    let n = 1;
    ticker.textContent = `알림: 전산 점검 안내 ${n}호`;
    ticker.hidden = false;
    setInterval(() => {
        n += 1;
        ticker.textContent = `알림: 전산 점검 안내 ${n}호`;
    }, 700);
}

if (new URLSearchParams(location.search).get('lazy')) {
    const list = document.getElementById('lazy-list');
    const show = (text) => { list.innerHTML = ''; const li = document.createElement('li'); li.textContent = text; list.append(li); };
    document.getElementById('lazy').hidden = false;
    setTimeout(() => show('1쪽 첫 항목: 보청기 구입 지원'), 2500);
    document.getElementById('next-page').addEventListener('click', () => show('2쪽 첫 항목: 휠체어 대여 지원'));
}

for (const el of document.querySelectorAll('[data-go]')) {
    el.addEventListener('click', () => {
        location.href = `/portal2.html?section=${el.dataset.go}`;
    });
}

for (const tab of document.querySelectorAll('[role="tab"]')) {
    tab.addEventListener('click', () => {
        for (const t of tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]')) {
            const on = t === tab;
            t.setAttribute('aria-selected', String(on));
            t.tabIndex = on ? 0 : -1;
            document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
        }
        if (tab.dataset.slow) {
            const p = document.getElementById(tab.getAttribute('aria-controls')).querySelector('p');
            p.textContent = '불러오는 중…';
            setTimeout(() => { p.textContent = tab.dataset.slow; }, 1500);
        }
    });
}

const linkTabs = Array.from(document.querySelectorAll('[data-panel]'));
for (const link of linkTabs) {
    link.addEventListener('click', () => {
        for (const l of linkTabs) {
            const on = l === link;
            const name = l.textContent.trim();
            for (const attr of ['title', 'aria-label']) {
                if (on) l.setAttribute(attr, `${name} 선택됨`);
                else l.removeAttribute(attr);
            }
            document.getElementById(l.dataset.panel).hidden = !on;
        }
    });
}

for (const btn of document.querySelectorAll('[aria-expanded]')) {
    btn.addEventListener('click', () => {
        const open = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', String(open));
        document.getElementById(btn.getAttribute('aria-controls')).hidden = !open;
    });
}

document.getElementById('open-notice').addEventListener('click', () => {
    document.getElementById('notice').hidden = false;
});

const article = document.getElementById('long-article');
for (let i = 1; i <= 45; i++) {
    const p = document.createElement('p');
    p.textContent = `${i}번째 안내 문단입니다. 보조기기 지원 제도는 지역과 장애 정도에 따라 세부 기준이 다를 수 있으며, 이 문단은 긴 본문을 시험하기 위해 만든 합성 문장입니다. 실제 제도와 다를 수 있으니 공식 안내를 함께 확인하세요.`;
    article.append(p);
}
const last = document.createElement('p');
last.textContent = '마지막 안내: 이의 신청은 결정 통지를 받은 날부터 90일 안에 할 수 있습니다.';
article.append(last);
export {};
