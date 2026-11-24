"""팀 이름 한글 표기.

API-Football 의 영어 이름을 한국 언론에서 흔히 쓰는 한글 이름으로 바꾼다.
없는 팀은 영어 그대로 두고, 수집할 때 "한글 이름 없음" 으로 알려 준다 → 아래 표에 한 줄 더하면 된다.
이름은 대소문자·악센트·FC 같은 꼬리표를 무시하고 맞춘다 ("FC Porto" = "Porto").
"""
from __future__ import annotations

import re
import unicodedata

_SPECIAL = str.maketrans({"ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "ß": "ss", "đ": "d", "Đ": "D",
                          "ł": "l", "Ł": "L", "ı": "i", "ü": "u", "Ü": "U"})
_DROP = {"fc", "cf", "afc", "sc", "ssc", "cfc", "kv", "fk", "sk", "1"}

NAMES: dict[str, str] = {
    # 잉글랜드
    "Arsenal": "아스널", "Aston Villa": "애스턴 빌라", "Bournemouth": "본머스", "Brentford": "브렌트퍼드",
    "Brighton": "브라이턴", "Brighton & Hove Albion": "브라이턴", "Burnley": "번리", "Chelsea": "첼시",
    "Coventry": "코번트리", "Coventry City": "코번트리", "Crystal Palace": "크리스털 팰리스", "Everton": "에버턴",
    "Fulham": "풀럼", "Hull City": "헐 시티", "Ipswich": "입스위치", "Ipswich Town": "입스위치",
    "Leeds": "리즈", "Leeds United": "리즈", "Leicester": "레스터", "Leicester City": "레스터",
    "Liverpool": "리버풀", "Luton": "루턴", "Manchester City": "맨체스터 시티", "Manchester United": "맨체스터 유나이티드",
    "Newcastle": "뉴캐슬", "Newcastle United": "뉴캐슬", "Nottingham Forest": "노팅엄 포리스트",
    "Sheffield Utd": "셰필드 유나이티드", "Sheffield United": "셰필드 유나이티드", "Southampton": "사우샘프턴",
    "Sunderland": "선덜랜드", "Tottenham": "토트넘", "Tottenham Hotspur": "토트넘", "West Ham": "웨스트햄",
    "West Ham United": "웨스트햄", "Wolves": "울버햄프턴", "Wolverhampton Wanderers": "울버햄프턴",
    "Middlesbrough": "미들즈브러", "Norwich": "노리치", "Norwich City": "노리치", "Watford": "왓퍼드",
    "West Brom": "웨스트브로미치", "West Bromwich Albion": "웨스트브로미치", "Stoke City": "스토크", "Stoke": "스토크",
    "Swansea": "스완지", "Swansea City": "스완지", "Cardiff": "카디프", "Cardiff City": "카디프",
    "Bristol City": "브리스틀 시티", "Blackburn": "블랙번", "Blackburn Rovers": "블랙번", "Preston": "프레스턴",
    "Millwall": "밀월", "QPR": "QPR", "Queens Park Rangers": "QPR", "Sheffield Wednesday": "셰필드 웬즈데이",
    "Derby": "더비", "Derby County": "더비", "Portsmouth": "포츠머스", "Oxford United": "옥스퍼드",
    "Plymouth": "플리머스", "Wrexham": "렉섬", "Charlton": "찰턴", "Birmingham": "버밍엄", "Birmingham City": "버밍엄",
    # 스페인
    "Real Madrid": "레알 마드리드", "Barcelona": "바르셀로나", "Atletico Madrid": "아틀레티코 마드리드",
    "Athletic Club": "아틀레틱 빌바오", "Real Sociedad": "레알 소시에다드", "Real Betis": "레알 베티스",
    "Villarreal": "비야레알", "Sevilla": "세비야", "Valencia": "발렌시아", "Girona": "지로나", "Celta Vigo": "셀타 비고",
    "Espanyol": "에스파뇰", "Getafe": "헤타페", "Osasuna": "오사수나", "Mallorca": "마요르카",
    "Rayo Vallecano": "라요 바예카노", "Las Palmas": "라스팔마스", "Alaves": "알라베스", "Leganes": "레가네스",
    "Valladolid": "바야돌리드", "Levante": "레반테", "Elche": "엘체", "Oviedo": "오비에도", "Real Oviedo": "오비에도",
    "Cadiz": "카디스", "Granada": "그라나다", "Almeria": "알메리아", "Racing Santander": "라싱 산탄데르",
    "Deportivo La Coruna": "데포르티보", "Sporting Gijon": "스포르팅 히혼", "Eibar": "에이바르", "Zaragoza": "사라고사",
    # 이탈리아
    "Inter": "인터 밀란", "AC Milan": "AC 밀란", "Juventus": "유벤투스", "Napoli": "나폴리", "AS Roma": "AS 로마",
    "Lazio": "라치오", "Atalanta": "아탈란타", "Fiorentina": "피오렌티나", "Bologna": "볼로냐", "Torino": "토리노",
    "Genoa": "제노아", "Udinese": "우디네세", "Lecce": "레체", "Cagliari": "칼리아리", "Empoli": "엠폴리",
    "Verona": "엘라스 베로나", "Hellas Verona": "엘라스 베로나", "Monza": "몬차", "Parma": "파르마", "Como": "코모",
    "Venezia": "베네치아", "Sassuolo": "사수올로", "Pisa": "피사", "Cremonese": "크레모네세", "Frosinone": "프로시노네",
    "Salernitana": "살레르니타나", "Sampdoria": "삼프도리아", "Palermo": "팔레르모",
    # 독일
    "Bayern München": "바이에른 뮌헨", "Bayern Munich": "바이에른 뮌헨", "Borussia Dortmund": "도르트문트",
    "Bayer Leverkusen": "레버쿠젠", "RB Leipzig": "라이프치히", "VfB Stuttgart": "슈투트가르트",
    "Eintracht Frankfurt": "프랑크푸르트", "SC Freiburg": "프라이부르크", "VfL Wolfsburg": "볼프스부르크",
    "Borussia Mönchengladbach": "묀헨글라트바흐", "Union Berlin": "우니온 베를린", "1. FC Union Berlin": "우니온 베를린",
    "Werder Bremen": "베르더 브레멘", "1899 Hoffenheim": "호펜하임", "Hoffenheim": "호펜하임", "FSV Mainz 05": "마인츠",
    "Mainz": "마인츠", "FC Augsburg": "아우크스부르크", "1. FC Heidenheim": "하이덴하임", "VfL Bochum": "보훔",
    "FC St. Pauli": "장크트파울리", "St. Pauli": "장크트파울리", "Holstein Kiel": "홀슈타인 킬", "Hamburger SV": "함부르크",
    "1. FC Köln": "쾰른", "FC Koln": "쾰른", "SV Darmstadt 98": "다름슈타트", "Hertha Berlin": "헤르타 베를린",
    "Schalke 04": "샬케", "Fortuna Düsseldorf": "뒤셀도르프", "Hannover 96": "하노버", "SC Paderborn 07": "파더보른",
    "Elversberg": "엘버스베르크",
    # 프랑스
    "Paris Saint Germain": "파리 생제르맹", "Paris Saint-Germain": "파리 생제르맹", "Marseille": "마르세유",
    "Monaco": "모나코", "Lille": "릴", "Lyon": "리옹", "Lens": "랑스", "Nice": "니스", "Rennes": "렌",
    "Stade Brestois 29": "브레스트", "Brest": "브레스트", "Strasbourg": "스트라스부르", "Toulouse": "툴루즈",
    "Montpellier": "몽펠리에", "Nantes": "낭트", "Reims": "랭스", "Le Havre": "르아브르", "Angers": "앙제",
    "Auxerre": "오세르", "Saint Etienne": "생테티엔", "Lorient": "로리앙", "Metz": "메스", "Paris FC": "파리 FC",
    # 네덜란드
    "Ajax": "아약스", "PSV Eindhoven": "PSV 에인트호번", "PSV": "PSV 에인트호번", "Feyenoord": "페예노르트",
    "AZ Alkmaar": "AZ 알크마르", "FC Twente": "트벤테", "Twente": "트벤테", "FC Utrecht": "위트레흐트",
    "Heerenveen": "헤이렌베인", "NEC Nijmegen": "NEC 네이메헌", "Go Ahead Eagles": "고 어헤드 이글스",
    "Sparta Rotterdam": "스파르타 로테르담", "PEC Zwolle": "즈볼러", "Fortuna Sittard": "포르튀나 시타르트",
    "Heracles": "헤라클레스", "NAC Breda": "NAC 브레다", "Groningen": "흐로닝언", "Willem II": "빌럼 2세",
    "Almere City FC": "알메러 시티", "RKC Waalwijk": "RKC 발베이크", "Telstar": "텔스타르", "Excelsior": "엑셀시오르",
    "Volendam": "폴렌담",
    # 포르투갈
    "Benfica": "벤피카", "FC Porto": "포르투", "Sporting CP": "스포르팅 CP", "SC Braga": "브라가", "Braga": "브라가",
    "Vitoria Guimaraes": "비토리아 기마랑이스", "Moreirense": "모레이렌스", "Gil Vicente": "질 비센트",
    "Rio Ave": "히우 아브", "Famalicao": "파말리캉", "Estoril": "이스토릴", "Casa Pia": "카사 피아", "Arouca": "아로카",
    "Santa Clara": "산타 클라라", "Nacional": "나시오날", "Estrela": "이스트렐라", "AVS": "AVS", "Boavista": "보아비스타",
    "Farense": "파렌세", "Tondela": "톤델라", "Alverca": "알베르카",
    # 튀르키예
    "Galatasaray": "갈라타사라이", "Fenerbahçe": "페네르바흐체", "Besiktas": "베식타스", "Trabzonspor": "트라브존스포르",
    "Basaksehir": "바샥셰히르", "Samsunspor": "삼순스포르", "Goztepe": "괴즈테페", "Eyupspor": "에위프스포르",
    "Kasimpasa": "카슴파샤", "Antalyaspor": "안탈리아스포르", "Alanyaspor": "알라니아스포르", "Konyaspor": "코니아스포르",
    "Sivasspor": "시바스스포르", "Kayserispor": "카이세리스포르", "Gaziantep FK": "가지안테프", "Rizespor": "리제스포르",
    "Kocaelispor": "코자엘리스포르", "Genclerbirligi": "겐츨레르비를리이",
    # 벨기에
    "Club Brugge KV": "클뤼프 브뤼허", "Club Brugge": "클뤼프 브뤼허", "Anderlecht": "안데를레흐트",
    "Union St. Gilloise": "위니옹 생질루아즈", "KRC Genk": "헹크", "Genk": "헹크", "Gent": "헨트", "Antwerp": "앤트워프",
    "Standard Liege": "스탕다르 리에주", "Cercle Brugge": "세르클러 브뤼허", "Westerlo": "베스테를로",
    "Mechelen": "메헬렌", "Charleroi": "샤를루아", "OH Leuven": "루뱅", "St. Truiden": "신트트라위던",
    "Dender": "덴더르", "Zulte Waregem": "쥘테 바레험", "La Louviere": "라루비에르",
    # 스코틀랜드
    "Celtic": "셀틱", "Rangers": "레인저스", "Aberdeen": "애버딘", "Hearts": "하츠", "Hibernian": "히버니언",
    "Motherwell": "마더웰", "Dundee": "던디", "Dundee Utd": "던디 유나이티드", "Kilmarnock": "킬마녹",
    "St Mirren": "세인트 미렌", "Livingston": "리빙스턴", "Falkirk": "폴커크", "Ross County": "로스 카운티",
    "St Johnstone": "세인트 존스톤",
    # 그 밖의 유럽 (챔스·유로파·컨퍼런스)
    "Red Bull Salzburg": "잘츠부르크", "Sturm Graz": "슈투름 그라츠", "Lask Linz": "LASK 린츠", "Rapid Vienna": "라피드 빈",
    "Shakhtar Donetsk": "샤흐타르 도네츠크", "Dynamo Kyiv": "디나모 키이우", "Slavia Praha": "슬라비아 프라하",
    "Sparta Praha": "스파르타 프라하", "Viktoria Plzen": "빅토리아 플젠", "Slovan Bratislava": "슬로반 브라티슬라바",
    "Bodo/Glimt": "보되/글림트", "Molde": "몰데", "Viking": "비킹", "Rosenborg": "로센보리", "Brann": "브란",
    "FC Copenhagen": "코펜하겐", "Midtjylland": "미트윌란", "Brondby": "브뢴뷔", "Malmo FF": "말뫼",
    "Olympiakos Piraeus": "올림피아코스", "PAOK": "PAOK", "AEK Athens FC": "AEK 아테네", "Panathinaikos": "파나티나이코스",
    "Dinamo Zagreb": "디나모 자그레브", "Crvena Zvezda": "츠르베나 즈베즈다", "Young Boys": "영 보이스", "Basel": "바젤",
    "Kairat Almaty": "카이라트", "Qarabag": "카라바흐", "Ferencvarosi TC": "페렌츠바로시", "Ludogorets": "루도고레츠",
    "Legia Warszawa": "레기아 바르샤바", "Lech Poznan": "레흐 포즈난", "Pafos": "파포스", "Celje": "첼레",
    "Maccabi Tel Aviv": "마카비 텔아비브", "Sabah FA": "사바흐", "Sabah FK": "사바흐",
    # 배당 쪽(The Odds API)에서 쓰는 다른 이름
    "Brighton and Hove Albion": "브라이턴", "RC Lens": "랑스", "Inter Milan": "인터 밀란", "Sporting Lisbon": "스포르팅 CP",
    "Bodø/Glimt": "보되/글림트", "Atlético Madrid": "아틀레티코 마드리드", "Tottenham Hotspur": "토트넘",
    # K리그1
    "Ulsan Hyundai FC": "울산 HD", "Ulsan HD": "울산 HD", "Jeonbuk Motors": "전북 현대", "Jeonbuk Hyundai Motors": "전북 현대",
    "Pohang Steelers": "포항 스틸러스", "FC Seoul": "FC 서울", "Suwon City FC": "수원 FC", "Suwon FC": "수원 FC",
    "Gangwon FC": "강원 FC", "Daegu FC": "대구 FC", "Incheon United": "인천 유나이티드", "Gwangju FC": "광주 FC",
    "Daejeon Citizen": "대전 하나시티즌", "Jeju United FC": "제주 SK", "Jeju SK": "제주 SK",
    "Gimcheon Sangmu FC": "김천 상무", "FC Anyang": "FC 안양", "Anyang": "FC 안양",
    "Suwon Samsung Bluewings": "수원 삼성", "Bucheon FC 1995": "부천 FC", "Jeonnam Dragons": "전남 드래곤즈",
    "Busan I Park": "부산 아이파크", "Seongnam FC": "성남 FC",
    "Seoul E-Land FC": "서울 이랜드", "Chungnam Asan": "충남 아산", "Gyeongnam FC": "경남 FC", "Gimpo FC": "김포 FC",
    "Cheonan City": "천안 시티", "Ansan Greeners": "안산 그리너스", "Hwaseong FC": "화성 FC", "Cheongju FC": "충북 청주",
    "Chungbuk Cheongju": "충북 청주", "Paju Frontier": "파주 프런티어", "Gimhae FC": "김해 FC", "Yongin FC": "용인 FC",
    "Busan IPark": "부산 아이파크", "Bucheon FC": "부천 FC", "Jeonnam Dragons FC": "전남 드래곤즈",
    # J1리그
    "Kashima": "가시마 앤틀러스", "Kashima Antlers": "가시마 앤틀러스", "Urawa": "우라와 레즈", "Urawa Red Diamonds": "우라와 레즈",
    "Kawasaki Frontale": "가와사키 프론탈레", "Yokohama F. Marinos": "요코하마 F. 마리노스", "Gamba Osaka": "감바 오사카",
    "Cerezo Osaka": "세레소 오사카", "Vissel Kobe": "비셀 고베", "Sanfrecce Hiroshima": "산프레체 히로시마",
    "Nagoya Grampus": "나고야 그램퍼스", "FC Tokyo": "FC 도쿄", "Tokyo Verdy": "도쿄 베르디", "Machida Zelvia": "마치다 젤비아",
    "Kashiwa Reysol": "가시와 레이솔", "Shonan Bellmare": "쇼난 벨마레", "Albirex Niigata": "알비렉스 니가타",
    "Avispa Fukuoka": "아비스파 후쿠오카", "Kyoto Sanga": "교토 상가", "Yokohama FC": "요코하마 FC",
    "Shimizu S-pulse": "시미즈 S펄스", "Fagiano Okayama": "파지아노 오카야마", "Consadole Sapporo": "콘사도레 삿포로",
    "Jubilo Iwata": "주빌로 이와타", "Sagan Tosu": "사간 도스", "V-Varen Nagasaki": "V-바렌 나가사키",
    "Mito Hollyhock": "미토 홀리호크",
    # J2리그
    "Vegalta Sendai": "베갈타 센다이", "Montedio Yamagata": "몬테디오 야마가타", "Ventforet Kofu": "반포레 고후",
    "Oita Trinita": "오이타 트리니타", "Tokushima Vortis": "도쿠시마 보르티스", "Roasso Kumamoto": "로아소 구마모토",
    "Ehime FC": "에히메 FC", "Iwaki FC": "이와키 FC", "JEF United Chiba": "제프 유나이티드 지바",
    "Renofa Yamaguchi": "레노파 야마구치", "Blaublitz Akita": "블라우블리츠 아키타", "Thespakusatsu Gunma": "더스파 군마",
    "Tochigi SC": "도치기 SC", "Kagoshima United": "가고시마 유나이티드", "Fujieda MYFC": "후지에다 MYFC",
    "Omiya Ardija": "오미야 아르디자", "RB Omiya Ardija": "오미야 아르디자", "Imabari": "이마바리", "FC Imabari": "이마바리",
    "Hokkaido Consadole Sapporo": "콘사도레 삿포로", "Kataller Toyama": "가탈레 도야마", "Tokyo Verdy 1969": "도쿄 베르디",
    "Zweigen Kanazawa": "츠바이겐 가나자와", "Matsumoto Yamaga": "마쓰모토 야마가", "Giravanz Kitakyushu": "기라반츠 기타큐슈",
    # MLS
    "Inter Miami": "인터 마이애미", "Inter Miami CF": "인터 마이애미", "Los Angeles Galaxy": "LA 갤럭시", "LA Galaxy": "LA 갤럭시",
    "Los Angeles FC": "LAFC", "LAFC": "LAFC", "Seattle Sounders": "시애틀 사운더스", "Seattle Sounders FC": "시애틀 사운더스",
    "Portland Timbers": "포틀랜드 팀버스", "Vancouver Whitecaps": "밴쿠버 화이트캡스", "Vancouver Whitecaps FC": "밴쿠버 화이트캡스",
    "San Diego": "샌디에이고 FC", "San Diego FC": "샌디에이고 FC", "San Jose Earthquakes": "새너제이 어스퀘이크스",
    "Real Salt Lake": "레알 솔트레이크", "Colorado Rapids": "콜로라도 래피즈", "Minnesota United FC": "미네소타 유나이티드",
    "Minnesota United": "미네소타 유나이티드", "Sporting Kansas City": "스포팅 캔자스시티", "St. Louis City": "세인트루이스 시티",
    "St. Louis City SC": "세인트루이스 시티", "Austin": "오스틴 FC", "Austin FC": "오스틴 FC", "FC Dallas": "FC 댄러스",
    "Houston Dynamo": "휴스턴 다이너모", "Houston Dynamo FC": "휴스턴 다이너모", "Chicago Fire": "시카고 파이어",
    "Chicago Fire FC": "시카고 파이어", "Columbus Crew": "콜럼버스 크루", "FC Cincinnati": "FC 신시내티",
    "Nashville SC": "내슐빌 SC", "Atlanta United FC": "애틀랜타 유나이티드", "Atlanta United": "애틀랜타 유나이티드",
    "Orlando City SC": "올랜도 시티", "Orlando City": "올랜도 시티", "Charlotte": "샬럿 FC", "Charlotte FC": "샬럿 FC",
    "DC United": "DC 유나이티드", "D.C. United": "DC 유나이티드", "Philadelphia Union": "필라델피아 유니언",
    "New York City FC": "뉴욕 시티", "New York Red Bulls": "뉴욕 레드불스", "New England Revolution": "뉴잉글랜드 레볼루션",
    "CF Montreal": "CF 몽레알", "Toronto FC": "토론토 FC",
}


def _key(name: str) -> str:
    s = unicodedata.normalize("NFKD", name.translate(_SPECIAL)).encode("ascii", "ignore").decode().lower()
    toks = [t for t in re.split(r"[^a-z0-9]+", s) if t and t not in _DROP]
    return " ".join(toks)


_TABLE = {_key(en): ko for en, ko in NAMES.items()}


def ko(name: str | None) -> str | None:
    """한글 이름. 표에 없거나 이미 한글이면 그대로."""
    if not name:
        return name
    return _TABLE.get(_key(name), name)


def known(name: str) -> bool:
    return _key(name) in _TABLE
