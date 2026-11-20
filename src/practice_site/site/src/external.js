// 테스트 포털: ?q= 로 검색하면 결과 목록을 보여준다(합성 데이터).
const q = new URLSearchParams(location.search).get('q');
if (q) {
    const results = document.getElementById('results');
    const list = document.getElementById('result-list');
    for (const title of [`${q} 신청 방법`, `${q} 지원 대상`, `${q} 자주 묻는 질문`]) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = `/external2.html?q=${encodeURIComponent(title)}`;
        a.textContent = title;
        li.append(a);
        list.append(li);
    }
    results.hidden = false;
    document.title = `[테스트] 외부 포털 - '${q}' 검색 결과`;
}
document.getElementById('opinion')?.addEventListener('submit', (e) => {
    e.preventDefault();
    document.title = '[테스트] 의견이 전송됨';
});
export {};
