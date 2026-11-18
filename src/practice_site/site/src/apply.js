const TOTAL_STEPS = 3;
const STEP_NAMES = ['신청인 정보', '소득·재산 신고', '검토 및 모의접수'];
const $ = (sel) => document.querySelector(sel);
const input = (id) => document.getElementById(id);
const form = $('#apply-form');
const prevBtn = $('#prev-btn');
const nextBtn = $('#next-btn');
const summary = $('#error-summary');
const dialog = $('#income-dialog');
const residenceToggle = input('residenceDiffers');
const residenceWrap = $('#residenceAddress-wrap');
let step = 1;
let popupShown = false;
const isAddress = (v) => {
    const t = v.trim().split(/\s+/);
    return t.length >= 3 && /\d/.test(v) && /(로|길|동|리|가)(\s|\d|$)/.test(v);
};
function setError(id, message) {
    const el = input(id);
    const err = document.getElementById(`${id}-error`);
    if (message)
        el.setAttribute('aria-invalid', 'true');
    else
        el.removeAttribute('aria-invalid');
    if (err) {
        err.textContent = message ?? '';
        err.hidden = !message;
    }
}
function validateStep(n) {
    const errors = [];
    const check = (id, label, message) => {
        setError(id, message);
        if (message)
            errors.push({ id, label, message });
    };
    if (n === 1) {
        const name = input('applicantName').value.trim();
        check('applicantName', '성명', !name ? '성명을 입력하세요.' : /^[가-힣A-Za-z ]{2,30}$/.test(name) ? null : '성명은 한글 또는 영문 2자 이상이어야 합니다.');
        const addr = input('address').value.trim();
        check('address', '주민등록 주소', !addr ? '주민등록 주소를 입력하세요.' : isAddress(addr) ? null : '도로명과 건물번호까지 입력하세요.');
        if (residenceToggle.checked) {
            const r = input('residenceAddress').value.trim();
            check('residenceAddress', '실거주지 주소', !r ? '실거주지 주소를 입력하세요.' : isAddress(r) ? null : '도로명과 건물번호까지 입력하세요.');
        }
        const phone = input('phone').value.replace(/\D/g, '');
        check('phone', '연락처', !phone || /^01[016789]\d{7,8}$/.test(phone) ? null : '휴대전화 번호 형식이 아닙니다.');
    }
    if (n === 2) {
        const v = input('householdSize').value;
        const num = Number(v);
        check('householdSize', '가구원 수', !v || (Number.isInteger(num) && num >= 1 && num <= 20) ? null : '1~20 사이 숫자를 입력하세요.');
    }
    return errors;
}
function renderSummary(errors) {
    summary.replaceChildren();
    summary.hidden = errors.length === 0;
    if (!errors.length)
        return;
    const h = document.createElement('h2');
    h.textContent = `입력 내용을 확인해 주세요 (${errors.length}건)`;
    const ul = document.createElement('ul');
    for (const e of errors) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = `#${e.id}`;
        a.textContent = `${e.label}: ${e.message}`;
        li.append(a);
        ul.append(li);
    }
    summary.append(h, ul);
    summary.focus();
}
function renderReview() {
    const list = $('#review-list');
    list.replaceChildren();
    const rows = [
        ['성명', input('applicantName').value],
        ['주민등록 주소', input('address').value],
        ['실거주지 주소', residenceToggle.checked ? input('residenceAddress').value : '주민등록 주소와 같음'],
        ['연락처', input('phone').value || '입력 안 함'],
        ['소득·재산 신고', (() => {
                const s = document.getElementById('incomeStatus');
                return s.value ? s.options[s.selectedIndex].text : '선택 안 함';
            })()],
        ['가구원 수', input('householdSize').value || '입력 안 함'],
    ];
    for (const [k, v] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        list.append(dt, dd);
    }
}
function showStep(n) {
    step = n;
    document.querySelectorAll('[data-step-panel]').forEach((p) => {
        p.hidden = Number(p.dataset.stepPanel) !== n;
    });
    document.querySelectorAll('#steps li').forEach((li, i) => {
        if (i + 1 === n)
            li.setAttribute('aria-current', 'step');
        else
            li.removeAttribute('aria-current');
    });
    prevBtn.disabled = n === 1;
    nextBtn.hidden = n === TOTAL_STEPS;
    document.title = `[모의] 장애인연금 신청 - ${n}단계: ${STEP_NAMES[n - 1]}`;
    if (n === TOTAL_STEPS)
        renderReview();
    document.getElementById(`step${n}-title`)?.focus();
    if (n === 2 && !popupShown)
        openDialog();
}
function openDialog() {
    popupShown = true;
    dialog.hidden = false;
    $('#income-dialog-close').focus();
}
function closeDialog() {
    dialog.hidden = true;
    document.getElementById(`step${step}-title`)?.focus();
}
$('#income-dialog-close').addEventListener('click', closeDialog);
dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape')
        closeDialog();
});
residenceToggle.addEventListener('change', () => {
    residenceWrap.hidden = !residenceToggle.checked;
    input('residenceAddress').required = residenceToggle.checked;
    if (!residenceToggle.checked) {
        input('residenceAddress').value = '';
        setError('residenceAddress', null);
    }
});
nextBtn.addEventListener('click', () => {
    const errors = validateStep(step);
    renderSummary(errors);
    if (errors.length) {
        input(errors[0].id).focus();
        summary.focus();
        return;
    }
    if (step < TOTAL_STEPS)
        showStep(step + 1);
});
prevBtn.addEventListener('click', () => {
    renderSummary([]);
    if (step > 1)
        showStep(step - 1);
});
form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (step !== TOTAL_STEPS)
        return;
    for (let n = 1; n < TOTAL_STEPS; n++) {
        const errors = validateStep(n);
        if (errors.length) {
            showStep(n);
            renderSummary(errors);
            return;
        }
    }
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const no = `MOCK-${ymd}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
    form.hidden = true;
    $('#steps').hidden = true;
    $('#receipt').hidden = false;
    $('#receipt-status').textContent = `모의 접수번호: ${no} (실제 접수 아님)`;
    document.title = '[모의] 장애인연금 신청 - 모의 접수 완료';
    $('#receipt-title').focus();
});
export {};
