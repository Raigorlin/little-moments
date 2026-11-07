pipeline {
  agent { label 'docker-host' }

  options {
    disableConcurrentBuilds()
    skipDefaultCheckout(true)
    timestamps()
  }

  triggers {
    pollSCM('H/5 * * * *')
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Build and deploy') {
      when {
        branch 'main'
      }
      steps {
        withCredentials([file(credentialsId: 'little-moments-openai-api-key-file', variable: 'OPENAI_API_KEY_FILE')]) {
          script {
            try {
              if (isUnix()) {
                sh '''
                  mkdir -p .secrets
                  cp "$OPENAI_API_KEY_FILE" .secrets/openai_api_key
                  chmod 600 .secrets/openai_api_key
                  docker compose build --pull app
                  docker compose up -d --force-recreate app
                  docker compose ps
                '''
              } else {
                bat '''
                  if not exist .secrets mkdir .secrets
                  if not exist .secrets exit /b 1
                  copy /Y "%OPENAI_API_KEY_FILE%" .secrets\\openai_api_key >NUL
                  if errorlevel 1 exit /b 1
                  docker compose build --pull app
                  if errorlevel 1 exit /b 1
                  docker compose up -d --force-recreate app
                  if errorlevel 1 exit /b 1
                  docker compose ps
                  if errorlevel 1 exit /b 1
                '''
              }

              def appPort = env.CAMPING_HOST_PORT?.trim() ?: '5182'
              withEnv(["APP_PORT=${appPort}"]) {
                retry(12) {
                  sleep(time: 5, unit: 'SECONDS')
                  if (isUnix()) {
                    sh 'curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${APP_PORT}/api/session" >/dev/null'
                  } else {
                    bat 'curl.exe --fail --silent --show-error --max-time 5 "http://127.0.0.1:%APP_PORT%/api/session" >NUL'
                  }
                }
              }
            } finally {
              if (isUnix()) {
                sh 'rm -f .secrets/openai_api_key'
              } else {
                bat 'if exist .secrets\\openai_api_key del /f /q .secrets\\openai_api_key'
              }
            }
          }
        }
      }
    }
  }
}
