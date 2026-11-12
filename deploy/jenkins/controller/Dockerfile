# Jenkins controller 映像（Requirement 2.4、2.5；tasks 19.3）。plugin 於建置時安裝，設定由 Configuration as Code 載入。
#
# 基底 lts-jdk21：jdk17 的 tag 停在一個已公布漏洞的 LTS，且 Java 17 已結束支援。
# 刻意不以 digest 固定：重建時即取得 LTS 的安全更新，代價是兩次建置的映像不保證相同，升級後須確認 plugin 相容。
FROM jenkins/jenkins:lts-jdk21

# 設定全部由 casc 目錄載入（compose.yaml 的 CASC_JENKINS_CONFIG），不經過 setup wizard。
ENV JAVA_OPTS="-Djenkins.install.runSetupWizard=false"

# --chown：主機上的 plugins.txt 可能是 0600。少了它，jenkins 使用者讀不到檔案，plugin 安裝程式印出
# 「Unable to open …plugins.txt」後仍印「Done」並成功結束，產生沒有任何 plugin 的映像；
# 該映像啟動的 Jenkins 沒有 Configuration as Code，因此沒有套用任何安全設定（未受保護）。
COPY --chown=jenkins:jenkins plugins.txt /usr/share/jenkins/ref/plugins.txt

# 安裝後以 ls 確認 configuration-as-code 與 job-dsl 確實已下載（.jpi 或 .hpi）；
# 任一缺少時 ls 以非零結束，建置明確失敗，而不是產生沒有 plugin 的映像。
RUN jenkins-plugin-cli --plugin-download-directory /usr/share/jenkins/ref/plugins --plugin-file /usr/share/jenkins/ref/plugins.txt \
 && ls /usr/share/jenkins/ref/plugins/configuration-as-code.?pi /usr/share/jenkins/ref/plugins/job-dsl.?pi > /dev/null \
 && echo "plugins in image: $(ls /usr/share/jenkins/ref/plugins | wc -l)"
