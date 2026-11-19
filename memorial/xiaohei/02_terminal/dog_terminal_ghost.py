"""Print one photograph in an 80x27 terminal, in truecolor.

The color data is an 80x54 RGB raster, zlib-compressed and base85-encoded.
Each character cell is a upper-half block: foreground = top pixel,
background = bottom pixel. No external files are needed.

Usage: python dog_terminal_ghost.py
"""
import base64
import hashlib
import os
import sys
import zlib

W, H = 80, 54
PIXEL_SHA256 = "6e60a61f54ff869541ab501d28ebf1266689f59783519f14b262606dccc27107"
DATA = """\
c-nQEby(Bu|Nj-
%&4TXk66_98vAd7Q?#_cKhytP#BA|4Lf`Wu}*I;ae1#31K8)cpNe7?W`f3NqZ9?$vyeq7J%zV6L!>~TL|b#wV5Il8^ER-
@7Br@n$FXZ`?9ef)F!(_cSp>NDs+Q=k6(Lz5r>1Dcrm3#6a^Q#bX8QR9<;YA5~})BirI`)ZVC{0m5}{X8=ENj3UWIXWXZNTHchsw
b72Nx6Dbt{RuCMwM!vM*DG0{~6K5*U`y8#-
{%KA$VwfMmzo24~@_KNB8l+`cMBe`Q?9RzWkrR_4$8{nuc%t@xPNZe@;yQ4uCIHq8mR{s7A(gQ(q>gzQU9L;+^^YAJDWxQvm+S2>
ze{C-
3;=9{_9Q9sAC!)_oZPjek~YKPksPDn@5ynrW$e3c(zikc~`8<YQdExSzuph~?4|{fPGC=r|yMF#;N;nfTqPe;vXP<cZJ!od&w^n)
$Iuc>e+-
BX7?02lZ8DN;ui6&;N_}PXq5aWQ6+5cNx6?&ikj4cYN}9?Zj7*(OiwuTm!EPH2zts{UjeloCR3P$fQ)Imny~qmNz7+s;;lBs_El!
g%Xu~M6U*9-
DmZ8Mvz+n6=dZ7S%7Tho%|;+VE)AW=MUbz^tc8i@8oCwci!*Ff6RRT69gNLb{axXJvOD)f6`5U(NF(AG5yEH$KMgn{Gp#VnrnppV
)PUQVGN8wYJ^pceKa}?u)`{ySUE11X@&&Dtu1ZYFEa}AUUalJar!s{p%i?Fw?I@FF@M(2M*pyTeEKgq{GZcp`n!zg{@~5eeAH0&R
-sT$On#o6`aC)P1vEYL6*Tkl_m7|c`1Iv3*mrbuB4Zxii%U+;EXaRV@wTd|uDPeZhu_DQ3<^~u>8Mnpld1IZJ=NMzV2x({6L>T-
Hlv;RU8$W>fWA39DH+iZtMnqpxKKViD3EnDH<y>beqHvqqUJ+=bwzF2>$bL@A*oKP{v^|Uf|OT}8`8lb;Dr^A4pz;?SJgNiAbcRa
Sg)P@YD}@okAF>m`a2(i)ac;k^dFOxUkhJ8u7CepCY4W2ewv&_c&EN=dgjZ_$FG14o0_`j1xr_X_|6HMyLj%Rl}lEx4~y8oY5V@&
2aX>(dFjHHsNe2Ay8kGx_-
);gbWHsnc2xJJk1JM<%_v5v<fBtk%@m}k1Z)LZi5haYvy=U<D8Dc_uexcVzDtx}SelZU^uD^CC)Nt&lLCoeEYV8jdKo19*he@n2n
>!u+1fMMKcs;DkW}3_B<vjEbPw_sqmvUe|1s#V34@_V8DYWPiK*YGCchTvB-Okt5(`DTiI0;8i>LlZ{yaSc`Z6&wQ(ND>GHktHz}
(=F#es7c1_aOd51i-
YAL`*9<mTz`>h24xvzzacQ<r<Vk`X9MYWSr8NlnkTw6d(OYlS){8_^qJbrLy*@t9yp!tU&?t*j|}nVIu4_w9#)ie^DtR&i`>{HyZ
1ULJoyFx1)0sj2O#sq1WN=fKCZ`LfFT&V=NbN6ucmem5cKRYgU8Q*B3keRpRor(dp~n3y&c6DY+qe;QNrU%V5OUrTaRtI7%lgM;I
`8AC{aLZbScVE;)!F{2sPR#et3UlZZ&9}*O@2zX&NY!>+k&G+#S@$n7x_6c-$@!Y-
tSbH~LF){&(+}z&JWHM*XnsxU4rOA)~l_<ugN}X7th2R%TGy<W#w~Jj-{x-
cZBcUiOqoUzeO;=9wn<r1=({gg(w=~yvx0Th@7ME2OmR1(LsVJ%V@TU9&<kXso9SfF(d-
w(~4qN}*qet0qOAD(it6JM6DlL>vJrt9f-;Gu1$NEE%zprvqDogVQxm@k|6!1b+f7eG4z-
q^J3WcJy?A?kr>pgwv1OzV#2wH%w!3+F?=KCVBL7razASY*!tvmNMw)Myq;{dp4{~>^#J$v@Xjhg@;ctJwh*q~H1I6N{SlGpZjWL
CerT9tD0ee(U{{Pcp7jI5joadD5IzpU!u)%A+<E1R-P-oLADeBaPiQc;<lp0(%DF~6XB0fBQZtZkh<z4jbCej_&K`n`M4a`J?b!&
844r-+{!e~^Np(iUYuDJ#rmcXy19Pw6K=>A&;pC#FF<{iJ48Baw(-zj*`k?BN~g7dY21Xs*BEm-
@rre~yn&Ai#Qf`Z+qft=qT_qE|gO-QLZknbB}q3?MIDumI)?fQ2v?N=Er&6-TIO;&SskKRjx9b-
D57shX6y%*1EOk1{jU3JdZZTDk^=W4(M$No8xn+nTzzuC4+8`^M%QF%Rc2S#4|QY;9|AYws|B;lcy^_nbO%@W8f>QFrbMgi77y??
7af5%Axd_>z|qSDcm9-ds1TogAO|sMF7Yr?8IergXZ=@p0XVN-Yu&y?XU(b@+OBFMr>FIlciQ{(&I@fua5ZA;1ff46yDVz7CFVtH
L76-q*qJy%8A=q;whuWjfo#-
EBy$l&W+hsYU?K3gm4)yrSyr)ORHr)$d~Jif>h?KhH^cot@O(R`)#R@udsr`Z<H0y*vQ#M`jR}NT#Z7?Yw&D{>t!;%U6aSJ9hk0T
zp=3R(4W+)UP|YhPYlndluoH_-cUtJU;RH2l(G70MdWXN{!CXNND&_p&r$Zj!z-
fx+$ZyTK(v#7J_+@&n+q}3}3qed;~y{krd?X7wqL70I;rZUiJ<yi<Yb`c=dKjqzn$7YdU*2%Zx%K;D~r!c}0zC4C<|FP^@5cMQ`6
#-%p6UoBH_ioBZpQFD|@KN_(Bu@Zt5jlZOd7EF9G1CyzVXy<n_-M6K59q{@-bp5B6@l4ohp3yTWcTbcy?0kLqfyP-
Pn)V`$-q_fA44GEOv`cFXmFMZ>kKwx#cPcM_Aa-TnFsClc>XjNl+(3pN2VtY(GF*>G)UnY~v1~}}zyqq=R>s;Kty?ufpVSRjqLEg
SWKVY3*JRBTdy?p{A@5W~56;r8X90qMhC6kDF`2JTfUxsOfFOcztvhH49QC>mH)A;;%MX#FQ=e4{m?fy{T@nPro4e&}d8f{`?5*>
Y4A{!pya-=eeOb%Z`Di#e64GstfxqvB^ij+#ph)Tw1cgCGRIM)hy`smTYA;sAE%$V*YOhiWgjjaEyHwbuNJc-Ope^^nPKfoK5jp|
k7lcTyRjS*HeE?209qT$}2p4^<QZQFJP1%(C&hx+*k`T7R>`UUw11pE0xvGQ|u_crjl*x5U6-
M0O}o?U3vY;YD}aac48W$NW@*HGJ_9{VT|kF>P(78jPjE34?~>+k1tC2|Ry-L-LDIKW~sfQyC={5tKJS~4t@%ft$hd>8;#kP}L&a
Raa#jZ(<%jlcLyh&lSyk)z1h*UpR@kpDrg`vjOjc+(%<EJ%;bNPdv^{8_(HE>-J>l^U5+tyF2m!}6}4zPg5%nwq-
8f`a?eQCH5NJ%0GW_RSIDVXHQ*58t<I`{Dh2f7!qHz`i|ucJ11-dDG@Cn-A^WY-vWqV$cLU7GSX$6dsGVF(WSw@IJJAXHG$7ezhX
zCFe;Y?^Uh1wnP59q}1QX9T>3~Ec`${r%)*EZOuR=lZt@UD5XMTluGfPSFI2X^gKL&Fqnk~e}PvsHZ?jv4ak2}>pqT;|3lB>uH>b
~q&|+ic=2>qQ&Zm{bopL(Kbz0zvU@s9-
xQ{2raw>5NJ>sgO?sN1l$aPBb?MCUeS3EN`pdqn=g&snydD$vTkO3%_wPpC`R%s{cdoAp^+uV@CX<OMlnIqYV9_Wn8kt2U(}*|<X
7(H(--9QjcOUv~>*oF8%a-
rox_zFPlfhXG91)R#B(JBZhgd8CSP=LtH~MQJ9Z^cua*0ME)hK0SBMJehJNC@JKql(+@e}+(8I1QZ=Np9}Yp1o^nSbhIO6;Yqq&v
?N@0>YxIQ4nbyNc41*9EUj@~TP;s$OTk$%@NKj!KHT8hP<()TQG|(KnJ~ZeBlmXy2w)dpE86b@#>-
`*)l^yyw)f`%WF+f91@vGdsg6SW^rdMZ{suX%t6m3mbEWIh{(U5J5~TnL)x^({QflWG5EciiS5QW87>lXcQ94#1xALgOUC<H#DTL
x3jaOrK_{GyQ{6IyS=xk1H|s_1Pl6lI{RVm?&#}ouX|f`W8XU9J$vF5!aF*NAcM=Jh{ndI{~-i_3V72W-
AH<H?brQVwr^Z<Z2zW<M|WKQW#i3X);&BG@$}rf<TGm%kFJW`8gz4`Z_NIs4}J~5zJ2cH2+v!aeQs^_yS>%_)|P<lTLP|b4vg8qc
wLYK1!u}46P&HgeVpuIwPw&56cUAqC*rXL9EO0$k%<Hbg+eEjSTw2y!_0y~vtrS)Xf(<c1wSS*pR8LG6?N<C^^4bUT)KAk!r3#&P
oFw^>C~}%Cr&;-e&)g9qc@Hmxqji?t!tOB96z{go@<~v=In_x{6Q)3s{R+Rac_7CnoNCgIW6u=V)TW*+r!;#>0TDNg-
)c^9;7XP<Wq}TH`Z8RT4r%!spW;G7Uvh6pIc&acCqEj1+3rJIwbG&O4;v~y5BqXfKT!PpBG1iPKSG1k}<XnvWpcf(9O}^*22n+Oe
f<h1U$4Qs9it}dom#7aU?vJgu_ya1VDxuppnU7@oW<l$oHs=XCBAJ-oJk*?%}<MkS*6Q-@bM!=IW)iOIJ&-
|CV?Da@v*aX^9D0na`ibMjc%<CxD4Mcj_FUFIB1aD$T@*W<sr=&}b%q);DC$<g>U-&*Cn}-
#NWw<8lu>x~~;!i6e1?7wJGS?fM$4hnwwVB5Y$L9PV#G6cb^0C*1Dx5>{lGb<!@kq}}dGyFHTjcqQ%idU`O(%a+cf675)YXKR+1y
`>|IW=6u(NO*HIiaCwOpi%&qghNwFc)&#ZvVj+#w`4LvG%^WFIT~e>nfQ?1(%e>8)78|_-
Q3XCRNvd&$ZlyGXlWYiXce@#3Od?_{cJIh(_Zub)`5-
w4AYBeF7o)&krBO7!254$pxx*+YF%3V<>v`k?%z7LVa<GR2lHS@`cil1IzQIV5Q`gOwuw8OV>dZRZ*q^`<Q5s>9JR^w_D0VOtDG)
}dEDI=ba$)&^>CNVs~jRXdYq34wq{Z7EzIoAf!D&t+T4;#0$vDLs8=*_7mGugpdhuW6e1)nfq;X$ZAKzOcAL{_Od7?CX-
2@J;c&|GUNlrz)Rn(&cwgRBSpjOTsRaD?`s&Wcny$tV-
A%RKO?5rZb?@^t&qOTnXP_^izsloFl*)0HN(cG|uGali<7&0;dHmIk#2fc+9NoHp`CMO*5KqT>-
i`}>ot6bUonGx6v&s3_<*u6+cx_(befHqCX9<r|A3aWteVCl^G&M2lY3##?k+)7C+;wux%JmC;E$L)i7S+*;;b6(MWzo%PWCoQ46
y9DQmX_933RG(-V`vJQNTra7L>wN60e>k(oF&r?CNU-
)3lYC~j$eCyRcn21Tf>L;#=7>VdZW5qntIxsdfS`&+7PkZntEFs%5$Hc2oLsUV6I)d&IewF7Lb)nosn8KGOilY{;ZJ^ZN{S;nU8P
BMxHyocl+w4i{|_Lg!*{S_48a9=y`0l``ryLI~IE_2o74ld}nlANnN9;wpmnFKUmu&sIKQ%)^h5bdF54I@%JA1y4YAT4gOj{KGH2
2RB#GHH^AFHV$E`MD_a)J+}g^5Ou_>%jY<Y$XwZg%1Ou@R$iPd*qjzsuJ;d!BVE6F)dj|*lhIpJIZa+xK=MD>a!$O_}5g(C&*IM=
F+?K`ObkvQjw+Hz!ioo=%RVaa4t5ku;{w0-i40xX>-
inDlfB4|;u;t6<2l&nP@tWu7voOHx=nB_6>s@v%@?0FUaAElUO=p`=#Pl4E?ml+E`&<J1!V}K<#Qy6keaX3;Gryj-
G$T4#F^%zT#h@{%BnFktGNaj9TRAz{GU#S@wl+4_mQ*6%j7)%g1f2ra3kL%U9tXkzJ`&PqR9{ESrs{V*4x7{4HNffR4zPIxY(9rA
;Bmx5fQ(QZc)3y`x3#M5%!WnYbkm#HfOlA~&={pqjw)26O2s!J4-
JBSdcyT*@z;O5c5?fc4GTl&1bVs#x;X{8JB4^S99(2~Gt7QtuwAHcXmHq5*R6Hd;cu<N-
ZIy`VXd#Q+1YBhr^{wr<NUqv7X&UgBV&Nn(UNX&$pmMC7yN?UWYVY%8pV>uu(V)8m4>OBWk$BMWI0${zzZ;FQ!5LmjkPrakDP<EC
DYxOSyfid>t{og<@9xPI6d6{9$sG$cr6^{fJA)G@E~`1hy!Y_cztU90xvr1_Vq|UUo4ZWWimCa2(tX2QWzxHK>nsYxP0N%zPTa6j
yBe=)+~Q}W~j6IJQvn4^Q>;Jv{~;%4|ER*T%GE*rQBszy8W``1rg8B9Dn!QwbozGG<$5T58YDa@8&}zVw|kZ9W5A^44MU<3T+nzS
!qT_#tch_86D~~9tV4C7Tv|pI?&V2+u0sGW-
`odZLA=;8DzY(1=Y{RrnaKAucxcGvkgIJcMY(+L3~c{5U)?b>lgC+Mf`s8V858(*Z8jZ=-
RoS40PnpDBzXKN2JmbscZy6mi<FUYS^U3U3waO;momJp&@~ew${$(v;bS`JV*LmYvLY1(xnAv;m#O8ry!q|&%9Tq`UdX}Ua;fV;j
1n8^Vtu}@-
Dwwu%j|~bFr6$CzFD6va+zCk%0*OwPsMvA*7L+iezw^g0vnA(bj?quy&SAFK7Fup#iQAHjvA7xJMBQObW@4MRm7jy~@b|*p8OQ?)
Dbg^!0S~_jYjmy9YVFf&sRG+b86)MLg(7z4fI9zlMc)F|l`U-
}}KU`~M4gQy!dq8hifInS&eFh0hJ}@v>(4TalJ|SRam99(`hK@`as|$9G;lef@mo+e2rbg|FVQXs*xQLz`=F#x`Dkl71vLWK*fvm
Wm+nMJx*1&YVuC5NKrh=0s~c*~kmc2-fc|(_plKifwOg4rd$e>$x!4(~<#4frB;;V;F=7gNVL$;Z$!&Yjb@~M{|7_)ZxySzOJ@`-
cE>W#N~k=0k;=!Mxue94<)(3tPJvE;qTtL&*O=tQk7KlxBefzl98v;ClaDgUA^$jj;#?3{e8S?giwmfg>_3B-
<F65`XoHgAiKA_qqn`CUt8Cm{qohrnCQZ%ag9%3Hpaeqe(uGb4JF>&sv?$cU=mGjm^3<>0QUlzIvmVtwhXGJ83hr9H_Ob{f&s8}3
W>?2FI%$W=&{pVw(efNV!4m29h?U6!pYcMFen7f>P2&#s>@sIs#@x++negTS{r*in)<ujxokl0;`etAa=HbGx~hw_4lWPyW)be)j
pcDg5{XhW{7pZDBN|2|6DuD@9!`IBrL-`$I6p1n?zN+vR&BARUG#J+dl=VMQ^#&<?QL#rt!rtjZEvV<t1PX3lUw>e`%OdYtHy-
9v<sO*>k56hy^mP3j!rPOFoUU>00Le!GE#q_P}?%iY|ZJw3o#6N&7jkqoE+U<-
5njBZEWq~5*_U4V@anVkw7Iu7b6pJ_LhvI%#^l<>ZaQFuy!=ncD2^`b+rui0&)khuan=`IRw;wot1?z_Am4IW|3m<J>+tQ!y>s@B
p((lKoZdKPxxY`)UZCecf6wbsdTV?TrsE;u?IS;-
=xIcToM|&G%V**)bopXQ?JLrj7`sq%P36ED@x6Obp27n`M9?aavPtPq?}I=2+Q`}TE1z;IvQa%i}o!tK{yPGOaf|>g9Q_Kt(Y_zw
9IG}J3Cu@dpiuq6n=<AJWN?m_BPf`Dho+`5(t_ym4wT9^02MGy0Q9QYh5KEcQ)6u+Z#FEt(;y6>~=o817HXHIx6xr_AK`CF(<{w#
B&D(VxdeVlp)AMgMP4!0ADT<$%cny&l4_Jzj-F)G$;jKilGkB5WDVW-
0e%@5!uJi<{mqda_nOA`S>U29%Mx)m8BP^#H7cZPbiGZtx0;5bn!({c((I~^6*9LSj1UKtU{{7L_xq1aA+Ep0z7~W=30P*aCd;wk
;O1KX9BnxjY_A}h$MoYwFS)ER&+89S}=`ZFen-U{rJu$2<iIwrA;;EEw%4E8fto5>-#&K`@!X&Hf~QFAoF_L-
{q$5Sm5PtMTvWmIKUYaBD_+uP>N6srNaRDUGT8Kv%9vW_{Ec(Z*miwYKnSVD|_3j2YMO>1079uRhjWAX~!<+9NC$9`j^BrF>yzup
Psv0n4F*cvONB7cE+u&*RjP3=Q4xW<=AehTDoYr4S5!YfCHQ0LPW-
)DR?Z?j7p_a;0oYuYYsiv4E_n)6O9Bb%#$G4n6v2iwpNZ7Ofw=DkHz2(f8Vg6;;!rudy|vaT>Y-
)Lq*Gn_pNmmUCkfBVnF6}H4k*R05YtlSt;A*dHC9xJ&Jz{Q<!i_A{-hvNFoyaTOAFJg-
`CMC0r@Zf5z+QsFWI&aug=6kr8D0?CIb?y_WD`_x?vmPv1X$GiJ}}`v*=Z-+Pvo-
<X<OlXj=%Rm{7%3ng=QR@m<AUAp$R3(bUxMKh5*0*-`5L14o;VP|87#}NWO>;he_tywfH3kHi$HKUTC2f?kuz-wl0PG=y0+`}MOU
=!5r*|R)s%#N%LiaND7`)O?cvxhaMxo!3DyP9izTI<>E4SgM8bmKrbfH%F)e7ZTr)z^;kBr$oQe{hH|0tp7ipzq*+i{H=fZf=8Sl
#`WK*VxA4iTOh^cK=XAb7xt3Rcdn9k$v}m*_(XkWX}1$zg=9v`Nq~=QRf~$NpDWd>`aKPe0II^+W9)aU%Ty&i&yPR_F&@3I1~gkg
f#dIRoaY*gNwYSxjB_gy0B@(w%{N~bGofL1ELvt!DxWBV3{%CXpq0s!F}J<WVQ(zi}JLjtnjnly&~XX_`Ds9Jg)3rk@?{Ahm!1G1
9ER$ZC^(nr>n8AqoMeD;)Y;ne@DyYq-UHy9&ccX&m9`%34aDR3V8_PiZYV#K8U`0;oPrRuAGdFyb^T>_Q!Ya+PZb)){SeAEM9wi-
nzSsmz`a)=+K5WCwA|;zyCt<&NGE;HYJ9IJy@_N&T+*f$FRpcc3$?eCQ)!`BG#0Q$507aGXh-dF*GtBl9k0`+}ph;bJyM=dwU|4%
A}jIXjF)Cs9;cy0TgYDGBq)Q3Wi0ST99!bmK1*n#tJ|CEem~?dYI35Acgr@{1O)Q^5KoH`uDwUb?nx<{`Lk~3sU03{O$amtx}Vp_
p`aY0Rf-
;4fbcj34r(maP8oCHde7a8*9t+b0An_FQms`io11u+r|}ZRxFBGv1sYMIl)2m{DPMG1h4f9+UOd%)hTF)wbuqK_tmx@tDJqqd_p%
aUU%T)zRdx)6bNJBC1O#~MCowd!=SJjQ%GC57Wun4o>{hRiC>_*vpb!^bhWlw=<3R(QfJMY1(*n{i3u1?!l0}vSXWDmiv?+(o5ku
t=hZ=OK2{_jD`KEEVXdE4%-
P+wrMd0(6<tl$U5!<_N%z;zaq)GuxOo0zQGU_8vhwQ64^0iNo$WpBZVtDP&mR!{u$#{la5;lRoGz)DFBS8IydHLIbxUP-
@$;ztTb76VIxO|Jj0j-
uUgouLZRmz&!Sh1`e1d|#1LykASvq&grd474SFJs^Xv4*w2X5ZjwRFCV83AKT!GpypCI!zT<MD8}H=PZg$<f}{-
NkWvQ1GD@;o<WZJ2<#3^9!8k<pDGEY=jqa7G4T1jEYCu&~Q%XWIG1I*Oofh-FkVj$J$U=cNR9#h7xQ|TII=1x_v^xX_JZiq(i-
Z?KS1a89C{X^Rm)j7v&Zg<`m>*<>!KO3Ul*{^9o-Vm6W}CS6NYATiwuD-
`d>NE*@kL3kSqQ10sH(c!(nvaYekYns@o}_pTn_vwq70w>4hO6&{R5Zp=Au)^h^fL+1E}&I?%?wr=yb1Dm&>T)E@Mf!)V<%(Y+W&
Y<8>zzd~^PQtM$1Of*6<BX}vEORE^&DkN;-EGgJCE+3S!sdh?TD-*D$zj&)S-
=V}ftSHW35PMI5m44tyd9lr54<+iP&X@x)dOqihPbfYS@;D`j3v(WV-
ca;&gv<>Qa3iN*GebGWs~Dl{n+rhMm(w#s$_hrh$G~8bJ(q&t+n+v<?qX0y)Mct%FE8ndXb%xF*wjE;P(hYyxzh7ZeD-
Ku%LfzWO!UH77zB+RhA^)zqxJQQa2l#4HfNW#|U({33Rs#@wE>M@CXbJT)blSwq-%y7Pw_zmX=hcGP5XnIuS!7U?~JFgfvi-aA-
(X8jTd>;<P#_aDAX(guf3Fheb#cXCabJuqac4q4QeN@YZH{YZ~6)-
fW?lorf)J?R@XuEBu`pcz<h3kTr3!t66E*qv;9NIKnHL7?bG7BokWc<hX1~r<l?yjhY-
+Olal$F{xHPtWgS;Qn)hr^EvI^Ej9h!O#|%Kfxb2_yPeb9!tQF|_O>V_0~6!YDV<z5Disg0%S-
caUpX1RG|1PH?&nAga%1^9Gku&HOGBME%yqJ(V&=Ipy{yP|62^jxH>ZHVcp4FlG-
3i4>Mz79iHO5NK_g%&P^55Z49e74rXc1Ke^DlQw22uJ1MdZ7D=K!5GjoBborj&dr#<UX_?-
Ff7B*xQxa@C5$V<IHGc^LdIxRx_lVrM4$#+RX`Y{;@z~P@JwX%sZX>EBy%ZIYgrmF7N58dsc+Mf0gUCmWJtu+!sFMP<9UIm(&7#Y
_{dfMwA-
o3VZk<T1ATEsm2gKNDm?VZ18g(m}V;$cPcx1~BT2rM#=Nd{gVuu~D2F+@BDheeRF807DD5W28IB7HVetI(#iQ3i|2cr=v&Z$Z(CS
X&w{)RpDuXyIzha<niD4|R)}>p~}>tSA@{3qo1Jvze)H{_4m6mTnY@YLLNkxe?YVI05~rSg#Si%6(d1lJTKDzp1*UwYIFSp}f7Zq
NAyzwf-
$g#Or{QnVuLiQp09^RMOJ${_>dvtAcGehT803<+gpHBa4V)kufeTl06;IB;k;+O@wcb0gGY$fTj$+38ET|#u})>Q<K?1i?m!c3h@
_@MnN!;a42{SjexPI<L0_sI9t(NZCI{0jAj0g8|DEomWnkE^|I}0tI}zuqiUg%4g{oHwaB<Z(0(E{z=GE@okjw$$x4kbe34LEkXr
FNv*vAXeMM1I_3P%^(&oCd#+uh4A-8>UTs||Yo|#Z1;1h}|y+SGFWo0C;4D}3fplqM-
WJ^VSv8E9$NEl0SmWV~@koIKg#V}FhF))2Wc0<-;4R!2i;gIA-LwSdHF-TZ*GRD`I7U;yZWl~(M7_L^dh2FMd!442Mc#~Pj_HP+g
462obYSqxFN&p%g0SQ5Xqt%GV)WANh)kwy_3-
<8j*a#FfQTo%!>}SyhFXCS1K89N%cwJqVU0YGmQ2DB{x}>hM2sAv{`EgS9X=e1}6d)`0<5H-
N@cAtb?`kTFZXe%ffu9AXhKk29h!|@s!i&e4;?SmegMbwFAaKyol#R$p_QHUHGBLrJnizSJ!3>XfW)T*6SUQ?h;1U7B>|#Zo=V7@
f&>sGYLBSX0q>YV;<WjCu&R59?M-
)S9r9fj4vQY^~M~24?ya?lWjgE*lDv??tNQ%3X_W0(@)TrF_`vouKU*$e2EldHgtIKj~%X4er=U2bWt*<JO4s}gvAzzRL(W*fr;D
yMU(aTTnTuH|QF9s<%1dKTusnSTvMT1{ZoUyP$n?ia*pTZMiP(~v)8S)o+p=ud6v!PkT$-
o<JXxIhrEH`T^gG{iX5gaXOu2yD?ylhqm*qf2ChY#-
N_P2=zeNyp&T*6bzfLCCYS}6n~BdPX>r{7^m4dw!GLe%LeG3QerUQT~<>t*WQyo}hQtb~%hCuK#?-
oMGHew$rWo?BV^qPeD6A!che@PR^O^&1C`$+Rlr&Q)`$s97*P<508V3qt}D&`4H7KZRlin1<epGK4g84uENdMR?Js7^F<k#-
UMolqq!ZKnL0!X9ird=wyO9jpS@aceA0-_b?A}qRtEQNqU^n)L0D-6i78nk<m5q)CfB|BKn7?hE@A5l7-
NfM&v_rktgEsoOpEi)RUNVsqt4{B>e_P=Vv}F&PsTb52fsRRoRQ`w^@~?ne2`#@YGP=kqWOHlL7LKUUl}s1_Li*5DsNRLN+L@p#(
uQf`_mNUc7<J*nJ?F30R~h!9yc52;$k+3_su1+>u40Q-}<>K*8;Uh=rOw-_z>&-u1cJX?$)M1g(KZtWgU!-
*`m^Sn&`2?J4XH&H^l$J0j;NM4dDWkRL~%NqKlF<H_x;XLphCe(|s*_wm~z2=9#Y*BLeMvc&xMZxzn~3o-
L?T662fb~<_%*oR=6nm~p^{ee9ZgEEvX5E|%UqWD&z&?Zo|2w05ae>%)I4p$J*<`jav6*bVA33UlGdluGYmc1owW7zTs_pUWJl#i
%{`f)jwqftmDwRlt`GVnsSiVPC}Z{8nAVSpV1Sfz9zKJxgZsFR8JPJ;j$*5n5lo+n;=ksO(wb}ujUesNCxn}Vlri&M*rQrhZD)N;
NtHDHC$oSD`{o!M=UodtE+Xe$;eO~_b9M4(XLMh?VHAT>1>XQQFtiZj%0JeEnuTT(ENW*BD%-
kd>QyLxeK^wrwR!r`Hg(GjE+D`Zfhc(Boo2%r;vmp}s=0q}ny|4j<Mf9F+7x$<F7+;2w`B9A?aI-VGP@`sXQ&!r_mY~Rj8>R5DP)
`OC~#Mk+c-xZ~Bdp{V;zM&duBv2lYY+7hbLMj#1D-eVw)_?<Oz+$x6P^i&Z!;^-o1KAMpSlF1(o`s$@i-
?}><!p6$S6D*y<%+jiLSB<{xLYCVS4cQ21Evvh3<`)wq#YF-Wqb$%)4!d-
h%u>uAVb;?sboA5m@6Ode{lQo!^k7?caA39MUWrIoH8Omxqs$a{Kd?tH(sQG(RcH~=<GO9b4|WP2uZ}#s04bgoX>7v<Y{S6fU6A#
NP!pkBW?{ol8`ClTQ4?}LNG%Z&ocZ#-L|u_hzMVv7<ap={*{p5q!4#1B|S26k5byNR`5rmxBipSh-st)um5TH_wWXMgcOSQkXkWl
faS`>{Ssks%*{g&ZvPqw$Wg~0-8=CE`BC%<*rdi^$an&=eKY%6WPV0;UPeqs$urSlyIcads&3t=xUsUx-JD1>Tm!%PYYbha4nr-
1@`ZtCAgLik!EP8L0h36;1^9dYa&X7<l>3b}h1|Xm0$wAZQ#Z(I5b;}OqHd+E4~|p|6V#X(+Wmx1HmR4xs53pO1i=O#!t*dv8rhB
DhyW82v}1%6a@Gh7&Pqk>VL{K`Yy0otIP~z=VFdZ^KaubKK)(7i=|*;HWKMciL1ruzYWOILuxCWdNsGTpLql;!f|+Qz3L)`~L7~3
qCIN%N8=OTl7j4R5m~GjzE<G*2wdpOtzkZ0@$m?(5_B9N0n?*w%5>dBoxEBsnDFbu4qevJFewYh%$jl74Kf?(a4*^!VHNd|DHH5v
|ICUVfNP#l)%7+J}qCS8X4R-xs7Vh0U
"""


def main() -> None:
    raw = zlib.decompress(base64.b85decode("".join(DATA.split())))
    if len(raw) != W * H * 3:
        raise SystemExit(f"bad raster size: {len(raw)}")
    if hashlib.sha256(raw).hexdigest() != PIXEL_SHA256:
        raise SystemExit("raster checksum mismatch")

    if os.name == "nt":
        os.system("")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    rows = ["\x1b[?25l"]
    for y in range(0, H, 2):
        cells = []
        for x in range(W):
            top = (y * W + x) * 3
            bot = ((y + 1) * W + x) * 3
            r1, g1, b1 = raw[top:top + 3]
            r2, g2, b2 = raw[bot:bot + 3]
            cells.append(f"\x1b[38;2;{r1};{g1};{b1};48;2;{r2};{g2};{b2}m▀")
        rows.append("".join(cells) + "\x1b[0m")
    rows.append("\x1b[?25h")
    sys.stdout.write("\n".join(rows) + "\n")


if __name__ == "__main__":
    main()
